// ******************************************************************************************************
// PvP 1v1 arena mode.  Peer-symmetric: both players run their own local sim in a shared, mirrored arena
// with no mobs.  The attacker detects its own bullet hits and tells the victim; the victim applies the
// damage to itself (so its own field/defense still matter).  The room creator (id 0) is the match
// arbiter: it owns the score, the round resets and the 3-2-1 countdown.  First to WIN_SCORE rounds wins.
// ******************************************************************************************************
net.pvp = {
    score: [0, 0],          // [player0, player1]
    WIN_SCORE: 3,           // best of 5
    round: 0,
    roundActive: false,
    roundWinner: null,      // guards against double-scoring within a single round
    countdownText: "",
    winner: null,
    _roundTimer: null,      // auto-resolves a round that never ends (idle / disconnect)
    spawns: [{ x: -520, y: 120 }, { x: 520, y: 120 }],

    // ---- arena geometry (symmetric box + two platforms) --------------------
    rect(cx, cy, w, h) {
        const x = w / 2, y = h / 2
        return [[cx - x, cy - y], [cx + x, cy - y], [cx + x, cy + y], [cx - x, cy + y]]
    },
    arenaGeo() {
        const v = []
        v.push(this.rect(0, 320, 1800, 80))     // floor
        v.push(this.rect(-920, 0, 80, 720))     // left wall
        v.push(this.rect(920, 0, 80, 720))      // right wall
        v.push(this.rect(0, -360, 1800, 80))    // ceiling
        v.push(this.rect(-420, 120, 360, 36))   // left platform
        v.push(this.rect(420, 120, 360, 36))    // right platform
        v.push(this.rect(0, -60, 420, 36))      // center platform
        return { t: 'geo', lvl: 999, v, ex: 99999, ey: 0, en: 0, eny: 0 }
    },

    // ---- host: kick off the match ------------------------------------------
    hostStartMatch() {
        if (this._matchRunning) return
        if (net.playerCount < 2) { net.status(`room ${net.roomCode} — waiting for opponent…`); return }
        this._matchRunning = true
        const geo = this.arenaGeo()
        net.lastGeo = geo
        net.buildGeometry(geo)        // build locally on the host too
        net.send(geo)                 // and on the client
        this.score = [0, 0]
        this.startRound(1)
    },
    startRound(n) {
        this.round = n
        this.roundActive = false
        this.roundWinner = null
        this.winner = null
        this.placeSelf()
        net.send({ t: 'pvp', k: 'reset', round: n })
        this.send({ k: 'score', score: this.score })
        clearTimeout(this._roundTimer)
        this._roundTimer = setTimeout(() => this.roundTimeout(), 45000) // safety: no round runs forever
        this.runCountdown()
    },
    runCountdown() {
        let c = 3
        this.countdownText = c
        const tick = () => {
            c--
            if (c > 0) { this.countdownText = c; this.send({ k: 'count', n: c }); setTimeout(tick, 900) }
            else {
                this.countdownText = "FIGHT"
                this.roundActive = true
                m.immuneCycle = m.cycle + 90 // brief grace so the round doesn't open with a free hit
                this.send({ k: 'go' })
                setTimeout(() => { if (this.countdownText === "FIGHT") this.countdownText = "" }, 700)
            }
        }
        this.send({ k: 'count', n: 3 })
        setTimeout(tick, 900)
    },

    // ---- control messages (arbiter <-> peer) -------------------------------
    send(o) { o.t = 'pvp'; net.send(o) },
    onControl(msg) {
        switch (msg.k) {
            case 'reset': this.placeSelf(); this.roundActive = false; this.roundWinner = null; this.round = msg.round; break
            case 'count': this.countdownText = msg.n; break
            case 'go': this.countdownText = "FIGHT"; this.roundActive = true; m.immuneCycle = m.cycle + 90; setTimeout(() => { if (this.countdownText === "FIGHT") this.countdownText = "" }, 700); break
            case 'score': this.score = msg.score; net.updateHUD(); break
            case 'dead': // arbiter only: a player died, award the point
                if (net.role === 'host') this.hostOnDeath(msg.id, msg.round)
                break
            case 'win': this.winner = msg.winner; this.roundActive = false; this.showWinner(); break
        }
    },

    placeSelf() {
        const s = this.spawns[net.myId] || this.spawns[0]
        Matter.Body.setPosition(player, { x: s.x, y: s.y })
        Matter.Body.setVelocity(player, { x: 0, y: 0 })
        m.alive = true
        m.health = m.maxHealth
        m.energy = m.maxEnergy
        if (m.displayHealth) m.displayHealth()
        m.immuneCycle = m.cycle + 60
    },

    // ---- combat ------------------------------------------------------------
    // my bullets vs my opponent's body
    bulletHits() {
        if (!this.roundActive || !bullet.length) return
        const oppId = net.myId === 0 ? 1 : 0
        const opp = net.players[oppId]
        if (!opp || !opp.al) return
        const dmgScale = (typeof tech !== 'undefined' && tech.damageAdjustments) ? tech.damageAdjustments() : 1
        for (let i = bullet.length - 1; i >= 0; i--) {
            const dx = opp.rx - bullet[i].position.x, dy = opp.ry - bullet[i].position.y
            if (dx * dx + dy * dy < 34 * 34) {
                const dmg = (bullet[i].dmg || 0.06) * dmgScale + 0.05
                net.send({ t: 'pvphit', id: oppId, from: net.myId, d: Math.round(dmg * 1000) / 1000 })
                simulation.drawList.push({ x: bullet[i].position.x, y: bullet[i].position.y, radius: 16, color: "rgba(255,80,80,0.8)", time: 5 })
                bullet[i].endCycle = 0
                break
            }
        }
    },
    takeHit(d, from) {
        const oppId = net.myId === 0 ? 1 : 0
        if (from !== oppId) return // only the known opponent can damage me (anti-spoof)
        if (!this.roundActive || !m.alive || m.immuneCycle > m.cycle) return
        m.takeDamage(Math.min(Math.max(0, d), 0.5)) // clamp; applies my own defense; may call m.death -> onLocalDeath
        net.sendSelf()
    },
    // single death entry point (called from the m.death() hook)
    onLocalDeath() {
        if (!m.alive) return true
        m.alive = false
        net.sendSelf()
        this.send({ k: 'dead', id: net.myId, round: this.round })
        if (net.role === 'host') this.hostOnDeath(net.myId, this.round)
        return true
    },
    hostOnDeath(deadId, round) {
        if (net.role !== 'host') return                                  // only the arbiter scores
        if (round !== undefined && round !== this.round) return          // ignore a stale death from a finished round
        if (this.roundWinner !== null || this.winner !== null) return    // one award per round
        clearTimeout(this._roundTimer)
        const winnerId = deadId === 0 ? 1 : 0
        this.roundWinner = winnerId
        this.score[winnerId]++
        this.send({ k: 'score', score: this.score })
        net.updateHUD()
        if (this.score[winnerId] >= this.WIN_SCORE) {
            this.winner = winnerId
            this.send({ k: 'win', winner: winnerId })
            this.showWinner()
        } else {
            setTimeout(() => this.startRound(this.round + 1), 2200)
        }
    },
    // a player disconnected mid-match -> the one still here wins the match
    opponentLeft() {
        if (net.role !== 'host' || this.winner !== null) return
        clearTimeout(this._roundTimer)
        this.winner = net.myId
        this.send({ k: 'win', winner: net.myId })
        this.showWinner()
        simulation.inGameConsole(`<em>opponent left — you win</em>`)
    },
    // a round that never resolves (idle/lag) -> award it to whoever has more health
    roundTimeout() {
        if (net.role !== 'host' || this.roundWinner !== null || this.winner !== null) return
        const oppId = net.myId === 0 ? 1 : 0
        const opp = net.players[oppId]
        const mine = m.maxHealth ? m.health / m.maxHealth : 0
        const theirs = opp ? opp.h : 0
        this.hostOnDeath(mine < theirs ? net.myId : oppId, this.round) // lower health loses
    },
    showWinner() {
        const youWon = this.winner === net.myId
        simulation.inGameConsole(`<em>${youWon ? "you WIN the match!" : "you lost the match"}</em>`)
    },

    // ---- per-frame overlay (drawn in world space, then we add screen text) --
    frame() {
        // screen-space overlay text is drawn after ctx.restore via a deferred flag
        net._pvpOverlay = this.countdownText
            ? this.countdownText
            : (this.winner !== null ? (this.winner === net.myId ? "VICTORY" : "DEFEAT") : "")
    },
    scoreText() {
        const me = net.myId === 0 ? this.score[0] : this.score[1]
        const them = net.myId === 0 ? this.score[1] : this.score[0]
        return `you ${me} — ${them} them  (first to ${this.WIN_SCORE})`
    }
}
