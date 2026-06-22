// ******************************************************************************************************
// Multiplayer netcode for n-gon
//   co-op  : host-authoritative.  the host runs the real simulation (mobs/physics/powerups) and
//            broadcasts it.  clients run their own LOCAL player (native feel) + render host "ghosts",
//            and report the damage their bullets do back to the host.  mobs and difficulty scale with
//            the number of connected players.
//   pvp 1v1: peer-symmetric.  both players run a local sim in a shared arena (no mobs).  the attacker
//            detects its own bullet hits and tells the victim, who applies the damage to itself.
// transport is abstracted (net.transport) so the relay can be swapped (Supabase Realtime today).
// every cross-module reference is guarded by net.role so single player is completely unaffected.
// ******************************************************************************************************
const net = {
    role: 'off',          // 'off' | 'host' | 'client'
    mode: null,           // 'coop' | 'pvp'
    roomCode: null,
    myId: 0,              // 0 = the room creator (host), 1.. = joiners
    myPeerId: null,
    myColor: { hue: 0, sat: 0, light: 100 }, // safe default until net.begin() assigns one
    started: false,
    transport: null,
    players: {},          // id -> remote player record (everyone except me)
    ghostMobs: {},        // host netId -> {x,y,a,sides,r,fill,h, rx,ry,ra}
    ghostPowerups: [],    // [{x,y,ty}]
    geoBodies: [],        // client: rebuilt static collision bodies for the shared world
    lastGeo: null,        // host: cached geometry of the current level (for late joiners)
    spawn: { x: 0, y: -50 },
    TICK: 3,              // network send cadence (every Nth frame ~ 20Hz @ 60fps)
    SMOOTH: 0.35,         // remote entity render smoothing
    nextPeerNum: 1,       // host: next player id to hand out
    bulletCap: 18,        // max own-bullet positions broadcast per frame
    hud: null,
    pvp: null,            // populated by net-pvp.js

    // ---- identity / colors -------------------------------------------------
    color(id) {
        const hue = (id * 67) % 360
        return { hue, sat: id === 0 ? 0 : 70, light: id === 0 ? 100 : 60 }
    },
    get playerCount() {
        return 1 + Object.keys(this.players).length
    },

    // ---- entry points (wired to the menu) ----------------------------------
    genCode() {
        const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        let s = ""
        for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)]
        return s
    },
    hostCoop() { net.begin('coop', 'host', net.genCode()) },
    joinCoop(code) { net.begin('coop', 'client', (code || '').toUpperCase().trim()) },
    hostPvp() { net.begin('pvp', 'host', net.genCode()) },
    joinPvp(code) { net.begin('pvp', 'client', (code || '').toUpperCase().trim()) },

    begin(mode, role, code) {
        if (!code) { net.status("enter a room code"); return }
        if (typeof SupabaseTransport === 'undefined' || !window.supabase) {
            net.status("multiplayer library failed to load — check your connection")
            return
        }
        net.mode = mode
        net.role = role
        net.roomCode = code
        net.myId = (role === 'host') ? 0 : -1   // assigned by host roster when joining
        net.myPeerId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + "_" + net.genCode() + net.genCode())
        net.myColor = net.color(role === 'host' ? 0 : 1)
        simulation.isMultiplayer = true
        net.status(role === 'host' ? `room ${code} — connecting…` : `joining ${code}…`)

        net.transport = new SupabaseTransport()
        net.transport.connect(code, {
            onReady: () => net.onConnected(),
            onMessage: (msg) => net.onMessage(msg),
            onLeave: (peerId) => net.onPeerLeave(peerId),
            onError: (e) => net.status("connection error: " + e)
        })
    },

    onConnected() {
        net.status(`room ${net.roomCode} — connected`)
        if (net.role === 'host') {
            net.beginLocalGame()
            // host announces itself; clients that are already waiting get a roster
            net.broadcastRoster()
        } else {
            // join the room, then wait for the host's welcome (id + geometry) before playing
            net.beginLocalGame()
            net.send({ t: 'join', peer: net.myPeerId })
            net.status(`room ${net.roomCode} — waiting for host…`)
        }
        net.updateHUD()
    },

    // start the local game.  coop-host runs the normal loop (it owns the world); everyone else
    // runs the lightweight client loop (local player + rendered ghosts, no mob simulation).
    beginLocalGame() {
        if (net.started) return
        net.started = true
        const mpMenu = document.getElementById('mp-menu')
        if (mpMenu) mpMenu.style.display = 'none'
        const useClientLoop = !(net.mode === 'coop' && net.role === 'host')
        // apply our player color
        m.color = { ...net.myColor }
        simulation.startGame()
        if (useClientLoop) {
            simulation.loop = net.clientLoop
            // clients/pvp don't build levels locally; suppress the pending world load
            simulation.clearNow = false
            net.clearWorldBodies()
            if (net.mode === 'pvp' && net.role === 'host' && net.pvp) net.pvp.hostStartMatch()
        }
        requestAnimationFrame(() => { if (m.setFillColors) m.setFillColors() })
    },

    // ---- messaging ---------------------------------------------------------
    send(obj) { if (net.transport) net.transport.send(obj) },

    onMessage(msg) {
        switch (msg.t) {
            case 'join': // host only: a new client wants in
                if (net.role === 'host') net.hostAcceptJoin(msg.peer)
                break
            case 'roster': // host -> all: id assignments + colors
                net.applyRoster(msg)
                break
            case 'p': // a peer's player state
                net.applyPlayerState(msg)
                break
            case 'w': // host -> clients: world snapshot (mobs + powerups)
                if (net.role === 'client') net.applyWorld(msg)
                break
            case 'geo': // host -> clients: level geometry
                if (net.role === 'client') net.buildGeometry(msg)
                break
            case 'mobdead': // host -> clients: a mob died
                if (net.role === 'client') delete net.ghostMobs[msg.i]
                break
            case 'hit': // client -> host: my bullet damaged a mob
                if (net.role === 'host') net.hostApplyMobHit(msg)
                break
            case 'dmg': // host -> a client: you took damage
                if (msg.id === net.myId) net.takeRemoteDamage(msg.d)
                break
            case 'pvphit': // opponent -> me: I was hit
                if (net.mode === 'pvp' && msg.id === net.myId && net.pvp) net.pvp.takeHit(msg.d, msg.from)
                break
            case 'pvp': // pvp control (score / round / countdown)
                if (net.mode === 'pvp' && net.pvp) net.pvp.onControl(msg)
                break
            case 'bye':
                net.onPeerLeave(msg.peer)
                break
            case 'full': // host rejected my join (room at capacity)
                if (msg.peer === net.myPeerId) net.status(`room ${net.roomCode} is full`)
                break
        }
    },

    // ---- host: roster management -------------------------------------------
    hostAcceptJoin(peer) {
        // is this peer already known?
        for (const id in net.players) if (net.players[id].peer === peer) { net.broadcastRoster(); return }
        const cap = net.mode === 'pvp' ? 2 : 4 // co-op caps at 4 (rate-limit safety); pvp is strictly 1v1
        if (net.playerCount >= cap) { net.send({ t: 'full', peer }); return }
        const id = net.nextPeerNum++
        net.players[id] = net.blankPlayer(id, peer)
        net.onPlayerCountChange()
        net.broadcastRoster()
        // bring the new client up to speed with the current level geometry
        if (net.lastGeo) net.send(net.lastGeo)
        if (net.mode === 'pvp' && net.pvp) net.pvp.hostStartMatch()
        simulation.inGameConsole(`<em>player ${id + 1} joined</em>`)
        net.updateHUD()
    },
    broadcastRoster() {
        const roster = [{ id: 0, peer: net.myPeerId }]
        for (const id in net.players) roster.push({ id: Number(id), peer: net.players[id].peer })
        net.send({ t: 'roster', mode: net.mode, list: roster })
    },
    applyRoster(msg) {
        net.mode = msg.mode || net.mode
        // find my own id from my peer key
        for (const r of msg.list) {
            if (r.peer === net.myPeerId) {
                if (net.myId !== r.id) { net.myId = r.id; net.myColor = net.color(r.id); m.color = { ...net.myColor }; if (m.setFillColors) m.setFillColors() }
            }
        }
        // ensure a record exists for every other player
        const live = {}
        for (const r of msg.list) {
            if (r.peer === net.myPeerId) continue
            live[r.id] = true
            if (!net.players[r.id]) net.players[r.id] = net.blankPlayer(r.id, r.peer)
        }
        for (const id in net.players) if (!live[id]) delete net.players[id]
        net.updateHUD()
    },
    blankPlayer(id, peer) {
        const c = net.color(id)
        return { id, peer, x: 0, y: 0, rx: 0, ry: 0, vx: 0, vy: 0, a: 0, h: 1, mh: 1, al: 1, fm: 0, fo: 0, cr: 0, yo: 49, gun: 0, bull: [], color: c, dmgCD: 0, lastSeen: 0 }
    },
    onPeerLeave(peer) {
        for (const id in net.players) {
            if (net.players[id].peer === peer) {
                simulation.inGameConsole(`<em>player ${Number(id) + 1} left</em>`)
                delete net.players[id]
            }
        }
        if (net.role === 'host') { net.onPlayerCountChange(); net.broadcastRoster() }
        if (net.mode === 'pvp' && net.role === 'host' && net.pvp) net.pvp.opponentLeft()
        net.updateHUD()
    },
    onPlayerCountChange() {
        // re-scale future mob spawns to the new party size
        if (typeof mobs !== 'undefined' && mobs.setMobSpawnHealth) mobs.setMobSpawnHealth()
        net.updateHUD()
    },

    // ---- per-frame: my own outgoing player state ---------------------------
    sendSelf() {
        if (!net.transport || net.myId < 0) return
        const bull = []
        for (let i = 0, len = Math.min(bullet.length, 60); i < len && bull.length < net.bulletCap; i++) {
            bull.push([Math.round(bullet[i].position.x), Math.round(bullet[i].position.y)])
        }
        net.send({
            t: 'p', id: net.myId,
            x: Math.round(m.pos.x), y: Math.round(m.pos.y),
            vx: Math.round(player.velocity.x * 10) / 10, vy: Math.round(player.velocity.y * 10) / 10,
            a: Math.round(m.angle * 100) / 100,
            h: Math.round(m.health * 1000) / 1000, mh: Math.round(m.maxHealth * 100) / 100,
            al: m.alive ? 1 : 0, fm: m.fieldMode || 0, fo: input.field ? 1 : 0,
            cr: m.crouch ? 1 : 0, yo: Math.round(m.yOff),
            gun: (b.activeGun == null ? -1 : b.activeGun),
            hue: net.myColor.hue, sat: net.myColor.sat, lit: net.myColor.light,
            bull
        })
    },
    applyPlayerState(msg) {
        if (msg.id === net.myId) return
        const p = net.players[msg.id]
        if (!p) return // unknown id — ignore until the host's roster registers this player (anti-spoof + no orphan ghosts)
        if (!p.lastSeen) { p.rx = msg.x; p.ry = msg.y } // snap on first sighting so the ghost doesn't fly in from (0,0)
        p.x = msg.x; p.y = msg.y; p.vx = msg.vx; p.vy = msg.vy; p.a = msg.a
        p.h = msg.h; p.mh = msg.mh; p.al = msg.al; p.fm = msg.fm; p.fo = msg.fo
        p.cr = msg.cr; p.yo = msg.yo; p.gun = msg.gun; p.bull = msg.bull || []
        if (msg.hue !== undefined) p.color = { hue: msg.hue, sat: msg.sat, light: msg.lit }
        p.lastSeen = simulation.cycle
    },

    // ---- host: world snapshot ----------------------------------------------
    sendWorld() {
        const list = []
        for (let i = 0, len = mob.length; i < len && list.length < 60; i++) {
            const o = mob[i]
            if (!o.alive) continue
            list.push({
                i: o.netId,
                x: Math.round(o.position.x), y: Math.round(o.position.y),
                a: Math.round(o.angle * 100) / 100,
                s: o.vertices ? o.vertices.length : 6,
                r: Math.round(o.radius || 20),
                h: Math.round(o.health * 1000) / 1000,
                f: o.fill
            })
        }
        const pu = []
        for (let i = 0, len = powerUp.length; i < len && pu.length < 30; i++) {
            pu.push({ x: Math.round(powerUp[i].position.x), y: Math.round(powerUp[i].position.y), ty: powerUp[i].name })
        }
        net.send({ t: 'w', cyc: simulation.cycle, lvl: level.onLevel, mob: list, pu })
    },
    applyWorld(msg) {
        // mobs
        const seen = {}
        for (const o of msg.mob) {
            seen[o.i] = true
            let g = net.ghostMobs[o.i]
            if (!g) g = net.ghostMobs[o.i] = { rx: o.x, ry: o.y, ra: o.a }
            g.x = o.x; g.y = o.y; g.a = o.a; g.sides = o.s; g.r = o.r; g.h = o.h; g.fill = o.f
            g.lastSeen = simulation.cycle
        }
        for (const i in net.ghostMobs) if (!seen[i]) delete net.ghostMobs[i]
        net.ghostPowerups = msg.pu || []
        if (msg.lvl !== undefined) net.curLevel = msg.lvl
    },

    // ---- host: geometry (sent once per level, resent to late joiners) -------
    broadcastGeometry() {
        const verts = []
        for (let i = 0, len = map.length; i < len; i++) {
            const v = map[i].vertices
            const poly = []
            for (let j = 0; j < v.length; j++) poly.push([Math.round(v[j].x), Math.round(v[j].y)])
            verts.push(poly)
        }
        net.lastGeo = {
            t: 'geo', lvl: level.onLevel,
            v: verts,
            ex: Math.round(level.exit.x), ey: Math.round(level.exit.y),
            en: Math.round(level.enter.x), eny: Math.round(level.enter.y)
        }
        net.spawn = { x: Math.round(level.enter.x) + 50, y: Math.round(level.enter.y) - 40 } // host respawn point
        net.send(net.lastGeo)
    },
    buildGeometry(msg) {
        net.clearWorldBodies()
        const Bodies = Matter.Bodies, World = Matter.World
        for (const poly of msg.v) {
            if (poly.length < 3) continue
            const pts = poly.map(p => ({ x: p[0], y: p[1] }))
            let cx = 0, cy = 0
            for (const p of pts) { cx += p.x; cy += p.y }
            cx /= pts.length; cy /= pts.length
            try {
                const body = Bodies.fromVertices(cx, cy, [pts], {
                    isStatic: true,
                    collisionFilter: { category: cat.map, mask: 0xFFFFFFFF }
                }, true)
                if (body) {
                    net.geoBodies.push(body)
                    World.add(engine.world, body)
                } else {
                    console.warn('net.buildGeometry: could not build collision body for a polygon (concave/degenerate)')
                }
            } catch (e) { console.warn('net.buildGeometry: polygon build threw', e && e.message) }
        }
        level.exit.x = msg.ex; level.exit.y = msg.ey
        level.enter.x = msg.en; level.enter.y = msg.eny
        net.spawn = { x: msg.en + 50, y: msg.eny - 40 }
        // (re)place our player at the entrance for the new level
        Matter.Body.setPosition(player, net.spawn)
        Matter.Body.setVelocity(player, { x: 0, y: 0 })
        m.health = m.maxHealth; if (m.displayHealth) m.displayHealth()
        net.ghostMobs = {}; net.curLevel = msg.lvl // always reset ghosts on (re)load, even for the same level number
        net.status(`room ${net.roomCode} — playing`)
    },
    clearWorldBodies() {
        if (typeof Matter === 'undefined' || !engine || !engine.world) return
        for (const b2 of net.geoBodies) Matter.World.remove(engine.world, b2)
        net.geoBodies = []
    },

    // ---- host: called once per host frame (from normalLoop) ----------------
    hostFrame() {
        net.drawRemotePlayers()
        net.drawGhostBullets()
        net.hostProximityDamage()
        if (simulation.cycle % net.TICK === 0) { net.sendSelf(); net.sendWorld() }
        net.updateHUD()
    },
    // mobs swarm everyone (foundPlayer targets nearest), but contact damage to remote
    // players is resolved here generically so we don't have to patch every mob attack.
    hostProximityDamage() {
        for (const id in net.players) {
            const p = net.players[id]
            if (!p.al || p.dmgCD > simulation.cycle) continue
            for (let i = 0, len = mob.length; i < len; i++) {
                const o = mob[i]
                if (!o.alive) continue
                const dx = o.position.x - p.x, dy = o.position.y - p.y
                const rad = (o.radius || 20) + 28
                if (dx * dx + dy * dy < rad * rad) {
                    const dmg = Math.min(0.02 + 0.015 * Math.sqrt(o.mass || 1), 0.25) * (o.damageScale ? o.damageScale() : 1)
                    net.send({ t: 'dmg', id: Number(id), d: Math.round(dmg * 1000) / 1000 })
                    p.dmgCD = simulation.cycle + 40
                    break
                }
            }
        }
    },
    hostApplyMobHit(msg) {
        const o = net.mobByNetId(msg.i)
        if (o && o.alive && o.damage) o.damage(Math.max(0, msg.d))
    },
    mobByNetId(id) {
        for (let i = 0, len = mob.length; i < len; i++) if (mob[i].netId === id) return mob[i]
        return null
    },
    // host: nearest player (real m + remote players) to a position, for mob targeting
    nearestPlayer(pos) {
        let best = player.position, bestD = Infinity
        if (m.alive) { const dx = player.position.x - pos.x, dy = player.position.y - pos.y; bestD = dx * dx + dy * dy }
        for (const id in net.players) {
            const p = net.players[id]
            if (!p.al) continue
            const dx = p.x - pos.x, dy = p.y - pos.y, d = dx * dx + dy * dy
            if (d < bestD) { bestD = d; best = { x: p.x, y: p.y } }
        }
        return best
    },

    // ---- damage to my local player (sent by host in co-op) -----------------
    takeRemoteDamage(d) {
        if (!m.alive || m.immuneCycle > m.cycle) return
        m.takeDamage(d)
        net.sendSelf()
    },
    // co-op death: arcade respawn instead of resetting the shared level (works for host AND client)
    onLocalDeath() {
        if (net.mode === 'pvp') { if (net.pvp) net.pvp.onLocalDeath(); return true }
        // co-op host dying must NOT run the single-player teardown (it would orphan every client)
        if (net.mode === 'coop' && net.role === 'host') {
            net.send({ t: 'p', id: 0, al: 0, h: 0, x: Math.round(m.pos.x), y: Math.round(m.pos.y), a: m.angle, mh: m.maxHealth, vx: 0, vy: 0, fm: 0, fo: 0, cr: 0, yo: 49, gun: -1, hue: net.myColor.hue, sat: net.myColor.sat, lit: net.myColor.light, bull: [] })
            simulation.inGameConsole(`<em>you died — respawning…</em>`)
            m.alive = false
            setTimeout(() => {
                m.alive = true
                m.health = m.maxHealth
                if (m.displayHealth) m.displayHealth()
                Matter.Body.setPosition(player, net.spawn)
                Matter.Body.setVelocity(player, { x: 0, y: 0 })
                m.immuneCycle = m.cycle + 180
                net.sendSelf()
            }, 2600)
            return true
        }
        if (net.role !== 'client') return false
        simulation.inGameConsole(`<em>you died — respawning…</em>`)
        m.alive = false
        net.send({ t: 'p', id: net.myId, x: Math.round(m.pos.x), y: Math.round(m.pos.y), al: 0, h: 0, mh: m.maxHealth, a: m.angle, vx: 0, vy: 0, fm: 0, fo: 0, cr: 0, yo: 49, gun: -1, hue: net.myColor.hue, sat: net.myColor.sat, lit: net.myColor.light, bull: [] })
        setTimeout(() => {
            m.alive = true
            m.health = m.maxHealth
            if (m.displayHealth) m.displayHealth()
            Matter.Body.setPosition(player, net.spawn)
            Matter.Body.setVelocity(player, { x: 0, y: 0 })
            m.immuneCycle = m.cycle + 180
        }, 2600)
        return true
    },

    // ---- the client / pvp game loop ----------------------------------------
    clientLoop() {
        simulation.gravity()
        Engine.update(engine, simulation.delta)
        simulation.wipe()
        simulation.textLog()
        if (m.onGround) m.groundControl(); else m.airControl()
        m.move()
        m.look()
        simulation.camera()
        net.drawGeometry()
        if (net.mode === 'coop') { net.drawGhostMobs(); net.drawGhostPowerups() }
        net.drawRemotePlayers()
        net.drawGhostBullets()
        m.draw()
        m.hold()
        if (net.mode !== 'pvp' || (net.pvp && net.pvp.roundActive)) b.fire() // no firing during the pvp countdown
        b.bulletRemove()
        b.bulletDraw()
        if (!m.isTimeDilated) b.bulletDo()
        if (net.mode === 'coop') net.clientBulletHits()
        else if (net.pvp) net.pvp.bulletHits()
        simulation.drawCircle()
        simulation.runEphemera()
        if (net.mode === 'pvp' && net.pvp) net.pvp.frame()
        ctx.restore()
        simulation.drawCursor()
        net.drawOverlay()
        if (simulation.cycle % net.TICK === 0) net.sendSelf()
        net.updateHUD()
    },

    // screen-space overlay (called after the camera transform is restored)
    drawOverlay() {
        const txt = net._pvpOverlay
        if (!txt) return
        ctx.save()
        ctx.textAlign = "center"
        ctx.font = "bold 90px Arial"
        ctx.fillStyle = txt === "VICTORY" ? "#2c2" : txt === "DEFEAT" ? "#c33" : "#333"
        ctx.globalAlpha = 0.85
        ctx.fillText(txt, canvas.width / 2, canvas.height / 2 - 60)
        ctx.restore()
    },
    _pvpOverlay: "",

    // client: my local bullets vs host ghost mobs -> report damage to host
    clientBulletHits() {
        if (!bullet.length) return
        const dmgScale = (typeof tech !== 'undefined' && tech.damageAdjustments) ? tech.damageAdjustments() : 1
        for (let i = bullet.length - 1; i >= 0; i--) {
            const bx = bullet[i].position.x, by = bullet[i].position.y
            for (const id in net.ghostMobs) {
                const g = net.ghostMobs[id]
                const dx = g.rx - bx, dy = g.ry - by
                const rad = (g.r || 20) + 6
                if (dx * dx + dy * dy < rad * rad) {
                    const dmg = (bullet[i].dmg || 0.02) * dmgScale
                    net.send({ t: 'hit', i: Number(id), d: Math.round(dmg * 1000) / 1000 })
                    // no optimistic g.h decrement — the host is authoritative and re-broadcasts health each tick (avoids multi-client desync)
                    simulation.drawList.push({ x: bx, y: by, radius: 12, color: "rgba(255,255,255,0.7)", time: 4 })
                    if (!bullet[i].isBulletPierce) { bullet[i].endCycle = 0 }
                    break
                }
            }
        }
    },

    // ---- rendering (all in world space, camera already applied) ------------
    drawGeometry() {
        if (!net.geoBodies.length) return
        ctx.beginPath()
        for (const b2 of net.geoBodies) {
            const v = b2.vertices
            ctx.moveTo(v[0].x, v[0].y)
            for (let j = 1; j < v.length; j++) ctx.lineTo(v[j].x, v[j].y)
            ctx.lineTo(v[0].x, v[0].y)
        }
        ctx.fillStyle = color.block
        ctx.fill()
        ctx.strokeStyle = color.blockS
        ctx.lineWidth = 1
        ctx.stroke()
        // draw the exit door (host drives progression, but show it)
        if (net.mode === 'coop') {
            ctx.fillStyle = "#0ff"
            ctx.fillRect(level.exit.x, level.exit.y - 80, 100, 110)
        }
    },
    drawGhostMobs() {
        for (const id in net.ghostMobs) {
            const g = net.ghostMobs[id]
            if (g.lastSeen !== undefined && simulation.cycle - g.lastSeen > 300) { delete net.ghostMobs[id]; continue } // host stopped sending -> expire
            g.rx += (g.x - g.rx) * net.SMOOTH
            g.ry += (g.y - g.ry) * net.SMOOTH
            g.ra += (g.a - g.ra) * net.SMOOTH
            const sides = Math.max(3, g.sides || 6), r = g.r || 20
            ctx.beginPath()
            for (let k = 0; k < sides; k++) {
                const ang = g.ra + k / sides * 2 * Math.PI
                const px = g.rx + r * Math.cos(ang), py = g.ry + r * Math.sin(ang)
                if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
            }
            ctx.closePath()
            ctx.fillStyle = g.fill || "#888"
            ctx.fill()
            ctx.strokeStyle = "#000"
            ctx.lineWidth = 2
            ctx.stroke()
            if (g.h < 0.99) { // health bar
                const w = r * 2, x = g.rx - r, y = g.ry - r * 1.5
                ctx.fillStyle = "rgba(100,100,100,0.3)"; ctx.fillRect(x, y, w, r * 0.3)
                ctx.fillStyle = "rgba(255,0,80,0.8)"; ctx.fillRect(x, y, w * Math.max(0, g.h), r * 0.3)
            }
        }
    },
    drawGhostPowerups() {
        for (const p of net.ghostPowerups) {
            ctx.beginPath()
            ctx.arc(p.x, p.y, 9, 0, 2 * Math.PI)
            ctx.fillStyle = p.ty === 'heal' ? "#0d0" : p.ty === 'ammo' ? "#fc0" : "#9cf"
            ctx.fill()
        }
    },
    drawRemotePlayers() {
        for (const id in net.players) {
            const p = net.players[id]
            if (!p.al) continue
            if (simulation.cycle - p.lastSeen > 240) continue // stale -> hide
            p.rx += (p.x - p.rx) * net.SMOOTH
            p.ry += (p.y - p.ry) * net.SMOOTH
            const cFill = `hsl(${p.color.hue},${p.color.sat}%,${p.color.light}%)`
            const cDark = `hsl(${p.color.hue},${p.color.sat}%,${Math.max(0, p.color.light - 30)}%)`
            ctx.save()
            ctx.translate(p.rx, p.ry)
            // simple legs
            ctx.strokeStyle = "#333"; ctx.lineWidth = 6
            ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(-12, 22); ctx.moveTo(8, 0); ctx.lineTo(12, 22); ctx.stroke()
            // body
            ctx.rotate(p.a)
            ctx.beginPath(); ctx.arc(0, 0, 30, 0, 2 * Math.PI)
            ctx.fillStyle = cFill; ctx.fill()
            ctx.strokeStyle = cDark; ctx.lineWidth = 4; ctx.stroke()
            // gun direction nub
            ctx.beginPath(); ctx.arc(20, 0, 6, 0, 2 * Math.PI); ctx.fillStyle = "#333"; ctx.fill()
            // field shimmer
            if (p.fo) { ctx.beginPath(); ctx.arc(0, 0, 50, 0, 2 * Math.PI); ctx.strokeStyle = `hsla(${p.color.hue},100%,70%,0.4)`; ctx.lineWidth = 3; ctx.stroke() }
            ctx.restore()
            // health ring + label
            ctx.beginPath(); ctx.arc(p.rx, p.ry, 38, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.max(0, Math.min(1, p.h)))
            ctx.strokeStyle = p.h > 0.3 ? "#3d8" : "#e44"; ctx.lineWidth = 4; ctx.stroke()
            ctx.fillStyle = "#000"; ctx.font = "14px Arial"; ctx.textAlign = "center"
            ctx.fillText("P" + (Number(id) + 1), p.rx, p.ry - 46)
        }
    },
    drawGhostBullets() {
        ctx.lineWidth = 1
        for (const id in net.players) {
            const p = net.players[id]
            if (!p.bull || !p.bull.length) continue
            ctx.fillStyle = `hsl(${p.color.hue},${p.color.sat}%,${Math.max(20, p.color.light - 40)}%)`
            for (const b2 of p.bull) {
                ctx.beginPath(); ctx.arc(b2[0], b2[1], 3, 0, 2 * Math.PI); ctx.fill()
            }
        }
    },

    // ---- HUD ----------------------------------------------------------------
    status(t) {
        const el = document.getElementById('mp-status')
        if (el) el.textContent = t
    },
    updateHUD() {
        if (!net.hud) net.hud = document.getElementById('net-hud')
        if (!net.hud || net.role === 'off') return
        let txt = `<b>room ${net.roomCode}</b>`
        if (net.mode === 'coop') txt += ` · ${net.playerCount} player${net.playerCount > 1 ? 's' : ''}`
        if (net.mode === 'pvp' && net.pvp) txt += ` · ${net.pvp.scoreText()}`
        net.hud.innerHTML = txt
        net.hud.style.display = 'block'
    },
    curLevel: -1
}
