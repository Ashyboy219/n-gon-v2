// ******************************************************************************************************
// Local game modes (single machine, no networking) — easy to test/iterate on each independently:
//   1. localpvp : couch 1v1. P1 = the mech (WASD + mouse aim + F/click fire).
//                 P2 = a robot (Arrow keys move, , / . rotate aim, / fire). Best of 5.
//   2. botpvp   : P1 vs N AI robots at a chosen difficulty. Kill them all to win.
//   3. wave     : survival — escalating waves of mobs + robots attack P1.
//
// Implementation: the opponent robots are regular mobs (so the existing engine handles P1's bullets
// hitting them and their bodies are auto-drawn). Each robot has a custom .do() that runs its
// controller (keyboard for P2, AI for bots), aims, and fires projectiles at P1.
// Everything is gated by `modes.active`, so it never touches normal single-player or `net`.
// ******************************************************************************************************
const modes = {
    active: null,           // null | 'localpvp' | 'botpvp' | 'wave'
    state: 'idle',          // 'countdown' | 'fighting' | 'roundover' | 'wavebreak' | 'matchover'
    opts: {},
    fighters: [],
    score: [0, 0],          // [P1, P2] for localpvp
    WIN_SCORE: 3,           // best of 5
    round: 0,
    wave: 0,
    _roundEnded: false,     // one-shot guard so simultaneous P1/P2 deaths can't both score
    enemiesToClear: 0,
    overlayText: "",
    subText: "",
    timerCycle: 0,          // simulation.cycle at which the current timed state ends
    p1Spawn: { x: -700, y: 300 },
    p2Spawn: { x: 700, y: 300 },
    input2: { up: false, down: false, left: false, right: false, aimL: false, aimR: false, fire: false },
    p1Aim: 0,
    p1KbAim: false,         // true once P1 uses keyboard aim; mouse movement turns it back off
    p1AimHold: { ccw: false, cw: false },
    _listeners: false,

    DIFF: {
        easy: { label: 'easy', hp: 0.7, fireCD: 95, accel: 0.0011, spread: 0.55, dmg: 0.025, color: '#37b24d' },
        normal: { label: 'normal', hp: 1.2, fireCD: 62, accel: 0.0015, spread: 0.28, dmg: 0.045, color: '#f08c00' },
        hard: { label: 'hard', hp: 2.0, fireCD: 42, accel: 0.0019, spread: 0.14, dmg: 0.06, color: '#e8590c' },
        insane: { label: 'insane', hp: 3.2, fireCD: 28, accel: 0.0024, spread: 0.06, dmg: 0.08, color: '#c2255c' },
    },

    // ---- menu entry points -------------------------------------------------
    localPvp() { modes.start('localpvp', {}) },
    botPvp(difficulty, count) { modes.start('botpvp', { difficulty: difficulty || 'normal', count: Math.max(1, Math.min(4, count || 1)) }) },
    waveMode() { modes.start('wave', {}) },

    start(kind, opts) {
        modes.active = kind
        modes.opts = opts
        modes.score = [0, 0]
        modes.round = 0
        modes.wave = 0
        modes.fighters = []
        simulation.isMultiplayer = false
        modes.attachListeners()
        const menus = ['mp-menu', 'practice-menu']
        for (const id of menus) { const el = document.getElementById(id); if (el) el.style.display = 'none' }
        simulation.startGame()   // builds the engine + player; level.start delegates to modes.buildLevel() (hooked)
    },

    // ---- custom "level" = the arena (called from the top of level.start) ----
    buildLevel() {
        modes.buildArena()
        setupCanvas()
        simulation.setupCamera()
        simulation.setZoom()
        level.addToWorld()
        simulation.draw.setPaths()
        b.respawnBots()
        m.resetHistory()
        level.custom = function () { }          // no level hazards / auto-spawns
        level.customTopLayer = function () { }
        level.exit.x = 9e9; level.exit.y = 0    // no exit door in arenas
        m.look = modes.p1Look                   // P1 keyboard-aim support (mouse still works)
        b.giveGuns(0)                           // nail gun for P1
        modes.onArenaReady()
    },
    buildArena() {
        const W = 2800, H = 1500, t = 80
        spawn.mapRect(-W / 2, H / 2 - t, W, t)        // floor
        spawn.mapRect(-W / 2, -H / 2, t, H)           // left wall
        spawn.mapRect(W / 2 - t, -H / 2, t, H)        // right wall
        spawn.mapRect(-W / 2, -H / 2, W, t)           // ceiling
        spawn.mapRect(-820, 180, 520, 38)             // platforms
        spawn.mapRect(300, 180, 520, 38)
        spawn.mapRect(-260, -210, 520, 38)
        modes.p1Spawn = { x: -780, y: 420 }
        modes.p2Spawn = { x: 780, y: 420 }
    },

    onArenaReady() {
        modes.placePlayer(modes.p1Spawn)
        m.health = m.maxHealth; if (m.displayHealth) m.displayHealth()
        if (modes.active === 'localpvp') {
            modes.round = 1
            modes.spawnFighter(modes.p2Spawn.x, modes.p2Spawn.y, 'p2', { hp: 1.4, fireCD: 55, accel: 0.0016, dmg: 0.05, color: '#e64980' })
            modes.beginCountdown(`ROUND ${modes.round}`)
        } else if (modes.active === 'botpvp') {
            const d = modes.DIFF[modes.opts.difficulty] || modes.DIFF.normal
            for (let i = 0; i < modes.opts.count; i++) {
                const ang = Math.PI * (0.25 + 0.5 * (i / Math.max(1, modes.opts.count - 1 || 1)))
                modes.spawnFighter(600 * Math.cos(ang) + 200, -200 + 300 * Math.sin(ang), 'bot', d)
            }
            modes.beginCountdown(`${modes.opts.count} ${d.label} bot${modes.opts.count > 1 ? 's' : ''}`)
        } else if (modes.active === 'wave') {
            modes.wave = 0
            modes.nextWave()
        }
        modes.hud()
    },
    placePlayer(p) {
        Matter.Body.setPosition(player, p)
        Matter.Body.setVelocity(player, { x: 0, y: 0 })
        m.alive = true
    },

    // ---- the opponent robot (a mob with a controller) ----------------------
    spawnFighter(x, y, controller, cfg) {
        mobs.spawn(x, y, 4, 34, cfg.color || '#e64980')
        const f = mob[mob.length - 1]
        f.isFighter = true
        f.isModeEnemy = true             // counts toward the win/clear condition
        f.controller = controller        // 'p2' | 'bot'
        f.cfg = cfg
        f.tier = 1
        f.health = cfg.hp
        f.damageReduction = 1            // takes full damage from P1's bullets
        f.leaveBody = false
        f.isDropPowerUp = false
        f.stroke = '#000'
        f.frictionAir = 0.06
        f.aimAngle = (x > 0) ? Math.PI : 0   // face the center
        f.fireCDcycle = 0
        f.g = 0                          // hovering robot — no gravity
        Matter.Body.setDensity(f, 0.0014)
        f.onDeath = function () { modes.onFighterDeath(this) }
        f.do = function () { modes.fighterUpdate(this) }
        modes.fighters.push(f)
        return f
    },

    fighterUpdate(f) {
        f.checkStatus()
        const canAct = (modes.state === 'fighting')
        // --- movement + aim ---
        if (f.controller === 'p2') {
            const a = f.cfg.accel * f.mass
            if (canAct) {
                if (modes.input2.left) f.force.x -= a
                if (modes.input2.right) f.force.x += a
                if (modes.input2.up) f.force.y -= a
                if (modes.input2.down) f.force.y += a
                if (modes.input2.aimL) f.aimAngle -= 0.05
                if (modes.input2.aimR) f.aimAngle += 0.05
                if (modes.input2.fire) modes.fighterShoot(f)
            }
        } else { // bot AI
            if (canAct && m.alive) modes.botThink(f)
        }
        // --- aim indicator + health bar (drawn in world space) ---
        const tip = f.radius + 16
        ctx.strokeStyle = f.cfg.color
        ctx.lineWidth = 5
        ctx.beginPath()
        ctx.moveTo(f.position.x, f.position.y)
        ctx.lineTo(f.position.x + tip * Math.cos(f.aimAngle), f.position.y + tip * Math.sin(f.aimAngle))
        ctx.stroke()
        // "eye"
        ctx.beginPath()
        ctx.arc(f.position.x + 12 * Math.cos(f.aimAngle), f.position.y + 12 * Math.sin(f.aimAngle), 5, 0, 2 * Math.PI)
        ctx.fillStyle = '#000'; ctx.fill()
        modes.fighterHealthBar(f)
    },
    fighterHealthBar(f) {
        const max = f.cfg.hp
        const frac = Math.max(0, f.health / max)
        const w = f.radius * 2.2, x = f.position.x - w / 2, y = f.position.y - f.radius - 16
        ctx.fillStyle = 'rgba(90,90,90,0.4)'; ctx.fillRect(x, y, w, 7)
        ctx.fillStyle = frac > 0.3 ? '#e8590c' : '#c0392b'; ctx.fillRect(x, y, w * frac, 7)
    },
    botThink(f) {
        // strafe at a stand-off distance from the player while firing
        const dx = m.pos.x - f.position.x, dy = m.pos.y - f.position.y
        const dist = Math.hypot(dx, dy) || 1
        const ideal = 360
        const toward = (dist > ideal) ? 1 : -0.8
        const a = f.cfg.accel * f.mass
        f.force.x += a * (dx / dist) * toward
        f.force.y += a * (dy / dist) * toward
        // gentle vertical bob / strafe so they're not sitting ducks
        f.force.x += a * 0.5 * Math.sin(simulation.cycle * 0.03 + f.index)
        f.force.y += a * 0.5 * Math.cos(simulation.cycle * 0.04 + f.index) - 0.00018 * f.mass // slight lift to hover
        // aim at player with difficulty-based spread
        const want = Math.atan2(dy, dx) + (Math.random() - 0.5) * f.cfg.spread
        let diff = ((want - f.aimAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI
        f.aimAngle += Math.max(-0.12, Math.min(0.12, diff))
        if (Math.random() < 0.04 && Math.abs(diff) < 0.5) modes.fighterShoot(f)
    },

    fighterShoot(f) {
        if (simulation.cycle < f.fireCDcycle) return
        f.fireCDcycle = simulation.cycle + (f.cfg.fireCD || 55)
        const ang = f.aimAngle, speed = 15
        mobs.spawn(f.position.x + 38 * Math.cos(ang), f.position.y + 38 * Math.sin(ang), 3, 8, f.cfg.color)
        const p = mob[mob.length - 1]
        p.isShot = true
        p.leaveBody = false
        p.isDropPowerUp = false
        p.damageReduction = 0
        p.stroke = 'transparent'
        p.collisionFilter.category = cat.mobBullet
        p.collisionFilter.mask = 0          // no physics collisions; we resolve hits in .do()
        p.frictionAir = 0
        p.g = 0
        p.vel = { x: speed * Math.cos(ang), y: speed * Math.sin(ang) }
        p.dmgToPlayer = f.cfg.dmg || 0.04
        p.endShotCycle = simulation.cycle + 150
        Matter.Body.setVelocity(p, p.vel)
        p.onDeath = function () { }
        p.do = function () {
            Matter.Body.setVelocity(this, this.vel)   // straight, constant velocity
            if (m.alive && m.immuneCycle < m.cycle) {
                const ddx = this.position.x - m.pos.x, ddy = this.position.y - m.pos.y
                if (ddx * ddx + ddy * ddy < (m.radius + this.radius) * (m.radius + this.radius)) {
                    m.takeDamage(this.dmgToPlayer)
                    simulation.drawList.push({ x: this.position.x, y: this.position.y, radius: 22, color: 'rgba(255,90,90,0.7)', time: 6 })
                    this.death(); return
                }
            }
            if (simulation.cycle > this.endShotCycle) this.death()
        }
    },

    // ---- per-frame state machine (called from normalLoop) ------------------
    update() {
        // P1 keyboard aim rotation
        if (modes.p1AimHold.ccw) { modes.p1Aim -= 0.045; modes.p1KbAim = true }
        if (modes.p1AimHold.cw) { modes.p1Aim += 0.045; modes.p1KbAim = true }

        const c = simulation.cycle
        switch (modes.state) {
            case 'countdown': {
                const left = modes.timerCycle - c
                if (left > 0) { modes.overlayText = String(Math.ceil(left / 60)) }
                else { modes.state = 'fighting'; modes.overlayText = 'FIGHT'; modes.timerCycle = c + 45; m.immuneCycle = m.cycle + 60 }
                break
            }
            case 'fighting':
                if (modes.overlayText === 'FIGHT' && c > modes.timerCycle) modes.overlayText = ''
                if (modes.aliveEnemies() === 0) modes.onEnemiesCleared()
                break
            case 'roundover':
                if (c > modes.timerCycle) modes.beginNextRoundOrEnd()
                break
            case 'wavebreak':
                modes.subText = `next wave in ${Math.ceil((modes.timerCycle - c) / 60)}…`
                if (c > modes.timerCycle) { modes.subText = ''; modes.nextWave() }
                break
            case 'matchover':
                if (c > modes.timerCycle) modes.exitToMenu()
                break
        }
    },
    aliveEnemies() {
        // count only tagged mode enemies, so projectiles (isShot) and any minions a mob spawns
        // can't block a wave/match from clearing
        let n = 0
        for (let i = 0; i < mob.length; i++) if (mob[i].alive && mob[i].isModeEnemy) n++
        return n
    },

    // ---- outcomes ----------------------------------------------------------
    onPlayerDeath() {
        if (!modes.active) return false
        if (modes.state !== 'fighting' || modes._roundEnded) return true // one outcome per round (no double-processing)
        modes._roundEnded = true
        if (modes.active === 'localpvp') {
            modes.score[1]++
            // don't fake death during roundover — just make P1 unkillable + heal until the next round resets
            m.immuneCycle = m.cycle + 1e9
            m.health = m.maxHealth; if (m.displayHealth) m.displayHealth()
            modes.endRound(1)
        } else { // botpvp / wave: player death = game over
            m.alive = false
            modes.matchOver(false, modes.active === 'wave' ? `you reached wave ${modes.wave}` : 'the robots won')
        }
        return true   // suppress the normal single-player death/teardown
    },
    onFighterDeath(f) {
        if (!modes.active) return
        const idx = modes.fighters.indexOf(f); if (idx >= 0) modes.fighters.splice(idx, 1)
        if (modes.state !== 'fighting' || modes._roundEnded) return
        if (modes.active === 'localpvp' && f.controller === 'p2') {
            modes._roundEnded = true
            modes.score[0]++
            modes.endRound(0)
        }
        // botpvp / wave clearing is detected by aliveEnemies()===0 in update()
    },
    onEnemiesCleared() {
        if (modes.active === 'botpvp') {
            modes.matchOver(true, 'all robots destroyed')
        } else if (modes.active === 'wave') {
            modes.state = 'wavebreak'
            modes.timerCycle = simulation.cycle + 210
            simulation.inGameConsole(`<em>wave ${modes.wave} cleared</em>`)
        }
    },
    endRound(winnerId) {
        modes.state = 'roundover'
        modes.timerCycle = simulation.cycle + 150
        modes.overlayText = winnerId === 0 ? 'P1 SCORES' : 'P2 SCORES'
        modes.clearShots()
        modes.hud()
    },
    beginNextRoundOrEnd() {
        if (modes.score[0] >= modes.WIN_SCORE || modes.score[1] >= modes.WIN_SCORE) {
            const p1won = modes.score[0] > modes.score[1]
            modes.matchOver(true, p1won ? 'PLAYER 1 WINS' : 'PLAYER 2 WINS', true)
            return
        }
        modes.round++
        // reset arena combatants
        modes.clearAllEnemies()
        modes.placePlayer(modes.p1Spawn); m.health = m.maxHealth; if (m.displayHealth) m.displayHealth()
        modes.spawnFighter(modes.p2Spawn.x, modes.p2Spawn.y, 'p2', { hp: 1.4, fireCD: 55, accel: 0.0016, dmg: 0.05, color: '#e64980' })
        modes.beginCountdown(`ROUND ${modes.round}`)
    },
    nextWave() {
        modes.wave++
        modes.clearShots()
        const w = modes.wave
        level.levelsCleared = w   // makes the existing mob difficulty scale with the wave
        if (level.updateDifficulty) level.updateDifficulty()
        spawn.setSpawnList()
        const pool = ['starter', 'hopper', 'springer', 'spinner', 'striker', 'slasher', 'sneaker', 'focuser', 'ghoster', 'shooter']
        const mobCount = 2 + Math.floor(w * 1.4)
        for (let i = 0; i < mobCount; i++) {
            const type = pool[Math.min(pool.length - 1, Math.floor(Math.random() * Math.min(pool.length, 3 + w)))]
            const x = (Math.random() < 0.5 ? -1 : 1) * (700 + Math.random() * 500)
            const y = -400 + Math.random() * 700
            if (spawn[type]) { spawn[type](x, y); if (mob.length) mob[mob.length - 1].isModeEnemy = true }
        }
        // every other wave, add robots too
        const botCount = Math.floor(w / 2)
        const diffName = w < 4 ? 'easy' : w < 8 ? 'normal' : 'hard'
        for (let i = 0; i < botCount; i++) {
            modes.spawnFighter((i % 2 ? 1 : -1) * 760, -260 + 160 * i, 'bot', modes.DIFF[diffName])
        }
        modes.beginCountdown(`WAVE ${w}`)
        modes.hud()
    },
    beginCountdown(title) {
        modes._roundEnded = false
        modes.state = 'countdown'
        modes.timerCycle = simulation.cycle + 180
        modes.overlayText = '3'
        modes.subText = title
        setTimeout(() => { if (modes.subText === title) modes.subText = '' }, 2600)
    },
    matchOver(playerWon, text, isPvp) {
        modes.state = 'matchover'
        modes.timerCycle = simulation.cycle + 360
        modes.overlayText = isPvp ? text : (playerWon ? 'VICTORY' : 'DEFEAT')
        modes.subText = isPvp ? '' : text
        modes.roundActive = false
    },
    exitToMenu() {
        modes.active = null
        modes.state = 'idle'
        m.look = m.lookDefault
        modes.detachListeners()
        // soft return to the title: reload keeps things simple and clean
        location.reload()
    },

    clearShots() {
        for (let i = mob.length - 1; i >= 0; i--) if (mob[i].isShot) { mob[i].alive = false }
    },
    clearAllEnemies() {
        for (let i = mob.length - 1; i >= 0; i--) mob[i].alive = false
        modes.fighters = []
    },

    // ---- P1 aim (mouse by default, keyboard with C / V) --------------------
    p1Look() {
        m.lookDefault()
        if (modes.p1KbAim) m.angle = modes.p1Aim
    },

    // ---- overlay (screen space, drawn after the camera transform) ----------
    drawOverlay() {
        if (modes.overlayText) {
            ctx.save()
            ctx.textAlign = 'center'
            ctx.font = 'bold 86px Arial'
            ctx.globalAlpha = 0.9
            ctx.fillStyle = modes.overlayText === 'DEFEAT' ? '#c0392b' : (modes.overlayText === 'VICTORY' ? '#2c9e2c' : '#333')
            ctx.fillText(modes.overlayText, canvas.width / 2, canvas.height / 2 - 70)
            ctx.restore()
        }
        if (modes.subText) {
            ctx.save()
            ctx.textAlign = 'center'
            ctx.font = '28px Arial'
            ctx.fillStyle = '#555'
            ctx.fillText(modes.subText, canvas.width / 2, canvas.height / 2 - 10)
            ctx.restore()
        }
    },
    hud() {
        const el = document.getElementById('net-hud')
        if (!el) return
        let txt = ''
        if (modes.active === 'localpvp') txt = `<b>COUCH 1v1</b> · P1 ${modes.score[0]} — ${modes.score[1]} P2 (first to ${modes.WIN_SCORE})`
        else if (modes.active === 'botpvp') txt = `<b>VS BOTS</b> · ${(modes.opts.difficulty || 'normal')} · ${modes.aliveEnemies()} left`
        else if (modes.active === 'wave') txt = `<b>WAVE ${modes.wave}</b> · ${modes.aliveEnemies()} enemies`
        el.innerHTML = txt
        el.style.display = 'block'
    },

    // ---- input: P2 (couch) + P1 keyboard aim -------------------------------
    onMouseMove() { if (modes.active) modes.p1KbAim = false },
    attachListeners() {
        if (modes._listeners) return
        modes._listeners = true
        // capture phase so we can steal the arrow keys from P1 in couch mode
        window.addEventListener('keydown', modes.onKeyDown, true)
        window.addEventListener('keyup', modes.onKeyUp, true)
        window.addEventListener('mousemove', modes.onMouseMove, true)
    },
    detachListeners() {
        if (!modes._listeners) return
        modes._listeners = false
        window.removeEventListener('keydown', modes.onKeyDown, true)
        window.removeEventListener('keyup', modes.onKeyUp, true)
        window.removeEventListener('mousemove', modes.onMouseMove, true)
    },
    onKeyDown(e) {
        if (!modes.active) return
        if (modes.active === 'localpvp' && modes.captureP2(e.code, true)) { e.stopImmediatePropagation(); e.preventDefault(); return }
        if (e.code === 'KeyC') { modes.p1AimHold.ccw = true; modes.p1KbAim = true }
        else if (e.code === 'KeyV') { modes.p1AimHold.cw = true; modes.p1KbAim = true }
    },
    onKeyUp(e) {
        if (!modes.active) return
        if (modes.active === 'localpvp' && modes.captureP2(e.code, false)) { e.stopImmediatePropagation(); return }
        if (e.code === 'KeyC') modes.p1AimHold.ccw = false
        else if (e.code === 'KeyV') modes.p1AimHold.cw = false
    },
    captureP2(code, down) {
        switch (code) {
            case 'ArrowLeft': modes.input2.left = down; return true
            case 'ArrowRight': modes.input2.right = down; return true
            case 'ArrowUp': modes.input2.up = down; return true
            case 'ArrowDown': modes.input2.down = down; return true
            case 'Comma': modes.input2.aimL = down; return true
            case 'Period': modes.input2.aimR = down; return true
            case 'Slash': modes.input2.fire = down; return true
        }
        return false
    },
}
