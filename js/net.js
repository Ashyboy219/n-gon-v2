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
    ghostPowerups: [],    // [{x,y,ty,s,id}]
    _pendingPickups: {},  // client: id -> {cycle,ty,x,y,s} awaiting the host's pickupOk
    standins: {},         // client: host netId -> off-world Matter body in mob[] (damage target for array-iterating weapons)
    ghostBodies: {},      // client: host body index -> {body, rx, ry, ra, lastSeen} kinematic dynamic bodies
    geoBodies: [],        // client: rebuilt static collision bodies for the shared world
    geoPolys: [],         // client: raw serialized map polygons (exact host shapes, for rendering)
    lastGeo: null,        // host: cached geometry of the current level (for late joiners)
    spawn: { x: 0, y: -50 },
    TICK: 3,              // network send cadence (every Nth frame ~ 20Hz @ 60fps)
    SMOOTH: 0.35,         // remote entity render smoothing
    nextPeerNum: 1,       // host: next player id to hand out
    bulletCap: 18,        // max own-bullet positions broadcast per frame
    // ---- security (relay model: behavioral guards only, no crypto) ----------
    HIT_CAP: 2,           // max single mob-damage a client may report (≈200x a typical bullet)
    DMG_CAP: 0.5,         // max single player-damage the host may apply to a client
    _hitRate: {},         // host: peer -> {t, c} sliding-window hit-message counter
    _hitSeen: {},         // host: "netId:peer" -> cycle, replay/dup suppression
    hostDisconnected: false,
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
            case 'pickup': // client -> host: I want to grab this power up
                if (net.role === 'host') net.hostHandlePickup(msg)
                break
            case 'pickupOk': // host -> all: a power up was consumed (and by whom)
                net.applyPickupOk(msg)
                break
            case 'dmg': // host -> a client: you took damage
                if (msg.id === net.myId) net.takeRemoteDamage(msg.d, msg._from)
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
        return { id, peer, x: 0, y: 0, rx: 0, ry: 0, vx: 0, vy: 0, a: 0, h: 1, mh: 1, al: 1, fm: 0, fo: 0, cr: 0, yo: 49, gun: 0, bull: [], color: c, dmgCD: 0, lastSeen: 0, og: 1, walk: 0, stepSize: 0, flip: -1 }
    },
    onPeerLeave(peer) {
        let hostLeft = false
        for (const id in net.players) {
            if (net.players[id].peer === peer) {
                if (Number(id) === 0) hostLeft = true
                simulation.inGameConsole(`<em>player ${Number(id) + 1} left</em>`)
                delete net.players[id]
            }
        }
        // co-op client losing the host: the authoritative world is gone — stop, don't strand the player
        if (hostLeft && net.mode === 'coop' && net.role === 'client' && !net.hostDisconnected) {
            net.hostDisconnected = true
            net.status(`host left — session ended`)
            simulation.inGameConsole(`<em>host disconnected — co-op session ended</em>`)
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
            t: 'p', id: net.myId, cyc: simulation.cycle,
            x: Math.round(m.pos.x), y: Math.round(m.pos.y),
            vx: Math.round(player.velocity.x * 10) / 10, vy: Math.round(player.velocity.y * 10) / 10,
            a: Math.round(m.angle * 100) / 100,
            h: Math.round(m.health * 1000) / 1000, mh: Math.round(m.maxHealth * 100) / 100,
            al: m.alive ? 1 : 0, fm: m.fieldMode || 0, fo: input.field ? 1 : 0,
            cr: m.crouch ? 1 : 0, yo: Math.round(m.yOff), og: m.onGround ? 1 : 0,
            gun: (b.activeGun == null ? -1 : b.activeGun),
            hue: net.myColor.hue, sat: net.myColor.sat, lit: net.myColor.light,
            bull
        })
    },
    applyPlayerState(msg) {
        if (msg.id === net.myId) return
        const p = net.players[msg.id]
        if (!p) return // unknown id — ignore until the host's roster registers this player (anti-spoof + no orphan ghosts)
        if (msg._from && p.peer && msg._from !== p.peer) return // claimed id must come from that id's registered peer (anti-spoof)
        if (msg.cyc !== undefined) { if (p._cyc !== undefined && msg.cyc < p._cyc) return; p._cyc = msg.cyc } // drop out-of-order/stale state
        if (!p.lastSeen) { p.rx = msg.x; p.ry = msg.y } // snap on first sighting so the ghost doesn't fly in from (0,0)
        p.x = msg.x; p.y = msg.y; p.vx = msg.vx; p.vy = msg.vy; p.a = msg.a
        p.h = msg.h; p.mh = msg.mh; p.al = msg.al; p.fm = msg.fm; p.fo = msg.fo
        p.cr = msg.cr; p.yo = msg.yo; p.gun = msg.gun; p.bull = msg.bull || []
        if (msg.og !== undefined) p.og = msg.og
        if (msg.hue !== undefined) p.color = { hue: msg.hue, sat: msg.sat, light: msg.lit }
        p.lastSeen = simulation.cycle
    },

    // ---- host: world snapshot ----------------------------------------------
    sendWorld() {
        const list = []
        for (let i = 0, len = mob.length; i < len && list.length < 60; i++) {
            const o = mob[i]
            if (!o.alive) continue
            // compact flag byte: 1=shield, 2=stun, 4=slow, 8=boss, 16=mobBullet
            let fl = 0
            if (o.isShielded) fl |= 1
            if (o.isStunned) fl |= 2
            if (o.isSlowed) fl |= 4
            if (o.isBoss) fl |= 8
            if (o.isMobBullet) fl |= 16
            list.push({
                i: o.netId,
                x: Math.round(o.position.x), y: Math.round(o.position.y),
                a: Math.round(o.angle * 100) / 100,
                s: o.vertices ? o.vertices.length : 6,
                r: Math.round(o.radius || 20),
                h: Math.round(o.health * 1000) / 1000,
                f: o.fill, fl
            })
        }
        const pu = []
        for (let i = 0, len = powerUp.length; i < len && pu.length < 30; i++) {
            pu.push({ x: Math.round(powerUp[i].position.x), y: Math.round(powerUp[i].position.y), ty: powerUp[i].name, s: Math.round(powerUp[i].size || 10), id: powerUp[i].netId })
        }
        // dynamic bodies (crates, printed blocks, and body-based level mechanisms: elevators/movers/doors)
        const bd = []
        for (let i = 0, len = body.length; i < len && bd.length < 30; i++) {
            const o = body[i]
            const v = o.vertices
            const poly = []
            for (let j = 0; j < v.length && j < 10; j++) poly.push([Math.round(v[j].x), Math.round(v[j].y)])
            bd.push({ i, v: poly })
        }
        net.send({ t: 'w', cyc: simulation.cycle, lvl: level.onLevel, mob: list, pu, bd })
    },
    applyWorld(msg) {
        // mobs (render ghosts) + off-world stand-in damage targets
        const seen = {}
        for (const o of msg.mob) {
            seen[o.i] = true
            let g = net.ghostMobs[o.i]
            if (!g) g = net.ghostMobs[o.i] = { rx: o.x, ry: o.y, ra: o.a }
            g.x = o.x; g.y = o.y; g.a = o.a; g.sides = o.s; g.r = o.r; g.h = o.h; g.fill = o.f
            g.fl = o.fl || 0
            g.lastSeen = simulation.cycle
            net.syncStandin(o) // keep a stand-in body in mob[] so the joiner's weapons can hit it
        }
        for (const i in net.ghostMobs) if (!seen[i]) { net.removeStandin(i); delete net.ghostMobs[i] }
        net.ghostPowerups = msg.pu || []
        net.syncGhostBodies(msg.bd || [])
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
            en: Math.round(level.enter.x), eny: Math.round(level.enter.y),
            bg: document.body.style.backgroundColor // match the host's per-level page background
        }
        net.spawn = { x: Math.round(level.enter.x) + 50, y: Math.round(level.enter.y) - 40 } // host respawn point
        net._hitSeen = {} // netIds change each level — drop the stale replay cache
        net.send(net.lastGeo)
    },
    buildGeometry(msg) {
        net.clearWorldBodies()
        // sanity-filter polygons (drop degenerate / absurd geometry a malformed or hostile host might send)
        const polys = (msg.v || []).filter(poly =>
            Array.isArray(poly) && poly.length >= 3 && poly.length <= 200 &&
            poly.every(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) < 1e6 && Math.abs(p[1]) < 1e6)
        )
        net.geoPolys = polys // keep the exact host polygons for rendering (collision bodies may be convex-decomposed)
        if (msg.bg) document.body.style.backgroundColor = msg.bg
        const Bodies = Matter.Bodies, World = Matter.World
        for (const poly of polys) {
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
        net.clearStandins(); net.clearGhostBodies()
        net.status(`room ${net.roomCode} — playing`)
    },
    clearWorldBodies() {
        if (typeof Matter === 'undefined' || !engine || !engine.world) return
        for (const b2 of net.geoBodies) Matter.World.remove(engine.world, b2)
        net.geoBodies = []
        net.geoPolys = []
        net.clearGhostBodies()
        net.clearStandins()
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
        const peer = msg._from || 'unknown'
        // rate limit: at most ~30 hit messages per peer per 30 cycles (half second)
        const rl = net._hitRate[peer] || (net._hitRate[peer] = { t: simulation.cycle, c: 0 })
        if (simulation.cycle - rl.t > 30) { rl.t = simulation.cycle; rl.c = 0 }
        if (++rl.c > 30) return
        // de-dupe a resent/replayed hit for the same mob from the same peer within a few cycles
        const key = msg.i + ':' + peer
        if (net._hitSeen[key] !== undefined && simulation.cycle - net._hitSeen[key] < 2) return
        net._hitSeen[key] = simulation.cycle
        const dmg = Math.max(0, Math.min(net.HIT_CAP, msg.d)) // clamp magnitude
        const o = net.mobByNetId(msg.i)
        if (o && o.alive && o.damage) o.damage(dmg)
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
    takeRemoteDamage(d, from) {
        if (!m.alive || m.immuneCycle > m.cycle) return
        // only the host may damage a co-op client; clamp the magnitude
        if (net.mode === 'coop' && net.role === 'client' && from !== undefined) {
            const hostPeer = net.players[0] && net.players[0].peer
            if (hostPeer && from !== hostPeer) return
        }
        m.takeDamage(Math.max(0, Math.min(net.DMG_CAP, d)))
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
        if (net.mode === 'coop') { net.drawGhostBodies(); net.drawGhostMobs(); net.drawGhostPowerups() }
        net.drawRemotePlayers()
        net.drawGhostBullets()
        m.draw()
        m.hold()
        if (net.mode !== 'pvp' || (net.pvp && net.pvp.roundActive)) b.fire() // no firing during the pvp countdown
        b.bulletRemove()
        b.bulletDraw()
        if (!m.isTimeDilated) b.bulletDo()
        if (net.mode === 'coop') { net.clientBulletHits(); net.clientBodyHits(); net.clientGrabPowerUps() }
        else if (net.pvp) net.pvp.bulletHits()
        // clients never own real power up bodies (they render host ghosts); drop any a local
        // effect spawned (e.g. heal overflow / Casimir) so they don't pile up invisibly.
        if (powerUp.length) { for (let i = powerUp.length - 1; i >= 0; i--) Matter.Composite.remove(engine.world, powerUp[i]); powerUp.length = 0 }
        simulation.drawCircle()
        simulation.runEphemera()
        if (net.mode === 'pvp' && net.pvp) net.pvp.frame()
        ctx.restore()
        simulation.drawCursor()
        net.drawOverlay()
        if (simulation.cycle % net.TICK === 0) { net.sendSelf(); if (net.mode === 'coop') net.flushStandinDamage() }
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

    // ---- power up pickup (client claims a ghost power up; host arbitrates) ----
    // client: look for nearby ghost power ups and ASK the host to grab them (host is authoritative
    // so two players can't claim the same one).  the effect is applied locally on pickupOk.
    clientGrabPowerUps() {
        if (!m.alive || simulation.isChoosing || simulation.paused) return
        const range2 = input.field ? m.grabPowerUpRange2 : 17000 // field reaches further, otherwise grab on contact
        for (const p of net.ghostPowerups) {
            if (p.id == null || net._pendingPickups[p.id]) continue
            if (p.ty === 'heal' && !(m.maxHealth - m.health > 0.01 || tech.isOverHeal)) continue // don't waste heals at full health
            if (p.ty === 'ammo' && tech.isEnergyNoAmmo) continue
            const dx = m.pos.x - p.x, dy = m.pos.y - p.y
            if (dx * dx + dy * dy < range2) {
                net._pendingPickups[p.id] = { cycle: simulation.cycle, ty: p.ty, x: p.x, y: p.y, s: p.s || 10 }
                net.send({ t: 'pickup', id: p.id, by: net.myId })
            }
        }
        // expire requests the host never answered (dropped packet / host gone) so they can be retried
        for (const id in net._pendingPickups) {
            if (simulation.cycle - net._pendingPickups[id].cycle > 120) delete net._pendingPickups[id]
        }
    },
    // host: a client asked to grab power up `id`.  consume it (once) and tell everyone who got it.
    hostHandlePickup(msg) {
        for (let i = 0, len = powerUp.length; i < len; i++) {
            if (powerUp[i].netId === msg.id) {
                Matter.Composite.remove(engine.world, powerUp[i])
                powerUp.splice(i, 1)
                net.send({ t: 'pickupOk', id: msg.id, by: msg.by })
                return
            }
        }
        net.send({ t: 'pickupOk', id: msg.id, by: -1 }) // already gone — just clear it on the requester
    },
    // everyone: a power up was consumed.  drop the ghost; if it was mine, apply the effect locally.
    applyPickupOk(msg) {
        net.ghostPowerups = net.ghostPowerups.filter(p => p.id !== msg.id)
        const info = net._pendingPickups[msg.id]
        delete net._pendingPickups[msg.id]
        if (msg.by === net.myId && info) net.applyPowerUpEffect(info)
    },
    // run a power up's real effect on the local player using a lightweight power-up-like object
    // (the effects read this.size / this.position, so we can't call powerUps[ty].effect() directly)
    applyPowerUpEffect(info) {
        const ty = info.ty
        if (!powerUps[ty] || typeof powerUps[ty].effect !== 'function') return
        const who = {
            name: ty, size: info.s, position: { x: info.x, y: info.y },
            velocity: { x: 0, y: 0 }, mass: 1, cycle: 999, isDuplicated: false,
            effect: powerUps[ty].effect
        }
        try {
            if (powerUps.onPickUp) powerUps.onPickUp(who)
            who.effect()
        } catch (e) { console.warn('net: client power up effect failed', ty, e && e.message) }
    },

    // ---- client weapon damage: off-world stand-in mobs --------------------------
    // The joiner's explosions / lasers / field / DoT iterate the global mob[] array and call
    // mob[i].damage().  We keep a lightweight stand-in body per host mob in mob[] (NOT in
    // engine.world, so the physics engine and its collision handler never touch it) whose damage()
    // just forwards to the host.  Direct bullets stay on net.clientBulletHits (proximity).
    syncStandin(o) {
        if (net.mode !== 'coop' || net.role !== 'client') return
        let s = net.standins[o.i]
        if (!s) {
            const sides = Math.max(3, Math.min(12, o.s || 6))
            try {
                s = Matter.Bodies.polygon(o.x, o.y, sides, o.r || 20, {
                    isStatic: true, isSensor: true, collisionFilter: { category: 0, mask: 0 }
                })
            } catch (e) { return }
            s.isNetGhost = true
            s.netId = o.i
            s.alive = true
            s.radius = o.r || 20
            s.leaveBody = false
            s.isDropPowerUp = false
            s.isBoss = false
            s.isInvulnerable = false
            s.shield = false
            s.memory = 0
            s.damageReduction = 1 // truthy so weapons that gate on it (e.g. laser) still deal damage
            s.seePlayer = { recall: 0, yes: false, position: { x: 0, y: 0 } }
            s.status = []
            s.foundPlayer = function () { }
            s.locatePlayer = function () { }
            s.distanceToPlayer2 = function () { return 1e9 }
            s.damageScale = function () { return 1 }
            s.death = function () { this.alive = false }
            s.do = function () { }
            s._pendingDmg = 0
            s.damage = function (dmg) { // forward to host instead of applying locally
                if (!this.alive || !(dmg > 0)) return
                this._pendingDmg += dmg
            }
            net.standins[o.i] = s
            mob.push(s)
        }
        // refresh state from the snapshot
        s.health = o.h
        s.alive = o.h > 0
        s.fill = o.f
        s.isShielded = !!(o.fl & 1)
        s.isStunned = !!(o.fl & 2)
        s.isSlowed = !!(o.fl & 4)
        s.isMobBullet = !!(o.fl & 16)
        try { Matter.Body.setPosition(s, { x: o.x, y: o.y }); Matter.Body.setAngle(s, o.a) } catch (e) { }
    },
    removeStandin(id) {
        const s = net.standins[id]
        if (!s) return
        const idx = mob.indexOf(s)
        if (idx !== -1) mob.splice(idx, 1)
        delete net.standins[id]
    },
    clearStandins() {
        for (const id in net.standins) net.removeStandin(id)
        net.standins = {}
    },
    // once per network tick: forward the damage the joiner's weapons dealt to each stand-in
    flushStandinDamage() {
        for (const id in net.standins) {
            const s = net.standins[id]
            if (s._pendingDmg > 0) {
                net.send({ t: 'hit', i: Number(id), d: Math.round(s._pendingDmg * 1000) / 1000 })
                s._pendingDmg = 0
            }
        }
    },
    // client: my thrown / printed blocks (local body[]) hitting host ghost mobs -> report damage
    clientBodyHits() {
        if (!body.length) return
        for (let bi = 0; bi < body.length; bi++) {
            const o = body[bi]
            if (!o || o.speed === undefined || o.speed < 8) continue
            for (const id in net.ghostMobs) {
                const g = net.ghostMobs[id]
                const dx = g.rx - o.position.x, dy = g.ry - o.position.y
                const rad = (g.r || 20) + (o.circleRadius || 14)
                if (dx * dx + dy * dy < rad * rad) {
                    const dmg = (typeof tech !== 'undefined' && tech.blockDamage ? tech.blockDamage : 0.06) * o.speed * (o.mass || 1) * 0.04
                    net.send({ t: 'hit', i: Number(id), d: Math.round(Math.min(dmg, 5) * 1000) / 1000 })
                    break
                }
            }
        }
    },

    // ---- dynamic bodies (crates/blocks + body-based level mechanisms) -----------
    syncGhostBodies(list) {
        if (net.mode !== 'coop' || net.role !== 'client' || typeof Matter === 'undefined') return
        const seen = {}
        for (const o of list) {
            if (!o.v || o.v.length < 3) continue
            seen[o.i] = true
            let gb = net.ghostBodies[o.i]
            // centroid of the polygon
            let cx = 0, cy = 0
            for (const p of o.v) { cx += p[0]; cy += p[1] }
            cx /= o.v.length; cy /= o.v.length
            if (!gb) {
                try {
                    const pts = o.v.map(p => ({ x: p[0], y: p[1] }))
                    const b2 = Matter.Bodies.fromVertices(cx, cy, [pts], {
                        isStatic: true, collisionFilter: { category: cat.body, mask: 0xFFFFFFFF }
                    }, true)
                    if (!b2) continue
                    b2.isNetGhostBody = true
                    Matter.World.add(engine.world, b2)
                    gb = net.ghostBodies[o.i] = { body: b2, rx: cx, ry: cy }
                } catch (e) { continue }
            }
            gb.x = cx; gb.y = cy; gb.lastSeen = simulation.cycle
            // smooth toward the new position so synced platforms don't teleport the standing player
            gb.rx += (gb.x - gb.rx) * net.SMOOTH
            gb.ry += (gb.y - gb.ry) * net.SMOOTH
            try { Matter.Body.setPosition(gb.body, { x: gb.rx, y: gb.ry }) } catch (e) { }
        }
        for (const i in net.ghostBodies) if (!seen[i]) net.removeGhostBody(i)
    },
    removeGhostBody(i) {
        const gb = net.ghostBodies[i]
        if (!gb) return
        try { Matter.World.remove(engine.world, gb.body) } catch (e) { }
        delete net.ghostBodies[i]
    },
    clearGhostBodies() {
        for (const i in net.ghostBodies) net.removeGhostBody(i)
        net.ghostBodies = {}
    },
    drawGhostBodies() {
        let any = false
        ctx.beginPath()
        for (const i in net.ghostBodies) {
            const v = net.ghostBodies[i].body.vertices
            ctx.moveTo(v[0].x, v[0].y)
            for (let j = 1; j < v.length; j++) ctx.lineTo(v[j].x, v[j].y)
            ctx.lineTo(v[0].x, v[0].y)
            any = true
        }
        if (!any) return
        ctx.fillStyle = color.block
        ctx.fill()
        ctx.strokeStyle = color.blockS
        ctx.lineWidth = 2
        ctx.stroke()
    },

    // ---- rendering (all in world space, camera already applied) ------------
    drawGeometry() {
        if (!net.geoPolys.length) return
        // draw the exact host map polygons (not the convex-decomposed collision bodies) with the
        // real map color so platforms match the host instead of looking washed-out.
        ctx.beginPath()
        for (const poly of net.geoPolys) {
            if (poly.length < 2) continue
            ctx.moveTo(poly[0][0], poly[0][1])
            for (let j = 1; j < poly.length; j++) ctx.lineTo(poly[j][0], poly[j][1])
            ctx.lineTo(poly[0][0], poly[0][1])
        }
        ctx.fillStyle = color.map
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
            if (g.lastSeen !== undefined && simulation.cycle - g.lastSeen > 300) { net.removeStandin(id); delete net.ghostMobs[id]; continue } // host stopped sending -> expire
            g.rx += (g.x - g.rx) * net.SMOOTH
            g.ry += (g.y - g.ry) * net.SMOOTH
            g.ra += (g.a - g.ra) * net.SMOOTH
            const sides = Math.max(3, g.sides || 6), r = g.r || 20
            const fl = g.fl || 0
            ctx.beginPath()
            for (let k = 0; k < sides; k++) {
                const ang = g.ra + k / sides * 2 * Math.PI
                const px = g.rx + r * Math.cos(ang), py = g.ry + r * Math.sin(ang)
                if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
            }
            ctx.closePath()
            ctx.fillStyle = g.fill || "#888"
            ctx.fill()
            if (fl & 2) { ctx.fillStyle = "rgba(255,255,0,0.25)"; ctx.fill() }       // stun tint
            ctx.strokeStyle = (fl & 4) ? "rgba(0,100,255,0.85)" : "#000"             // slow -> blue outline
            ctx.lineWidth = (fl & 4) ? 4 : 2
            ctx.stroke()
            if (fl & 1) { // shield bubble
                ctx.beginPath(); ctx.arc(g.rx, g.ry, r * 1.3, 0, 2 * Math.PI)
                ctx.fillStyle = "rgba(220,220,255,0.25)"; ctx.fill()
                ctx.strokeStyle = "#8cf"; ctx.lineWidth = 2; ctx.stroke()
            }
            if (g.h < 0.99) { // health bar
                const w = r * 2, x = g.rx - r, y = g.ry - r * 1.5
                ctx.fillStyle = "rgba(100,100,100,0.3)"; ctx.fillRect(x, y, w, r * 0.3)
                ctx.fillStyle = "rgba(255,0,80,0.8)"; ctx.fillRect(x, y, w * Math.max(0, g.h), r * 0.3)
            }
        }
    },
    // real powerup colors so ghost powerups match the host (see js/powerup.js per-type `color`)
    _puColor: {
        heal: "#0eb", ammo: "#467", field: "#0cf", gun: "#26a", tech: "hsl(246,100%,77%)",
        coupling: "#0ae", boost: "#f55", research: "#f7b", Casimir: "#ff0", entanglement: "#fff"
    },
    drawGhostPowerups() {
        if (!net.ghostPowerups.length) return
        ctx.globalAlpha = 0.4 * Math.sin(simulation.cycle * 0.15) + 0.6 // pulse, like powerUps.drawCircle
        for (const p of net.ghostPowerups) {
            ctx.beginPath()
            ctx.arc(p.x, p.y, p.s || 9, 0, 2 * Math.PI)
            ctx.fillStyle = net._puColor[p.ty] || "#9cf"
            ctx.fill()
        }
        ctx.globalAlpha = 1
    },
    // remote-player leg IK (mirrors m.calcLeg / player constants: legLength1 55, legLength2 45, hip 12/24, height 42)
    _LEG: { L1: 55, L2: 45, HIPX: 12, HIPY: 24, HEIGHT: 42 },
    _calcLeg(p, cycleOffset, offset) {
        const L = net._LEG
        const hipx = L.HIPX + offset, hipy = L.HIPY + offset
        const stepAngle = 0.034 * p.walk + cycleOffset
        let footx = 2.2 * p.stepSize * Math.cos(stepAngle) + offset
        let footy = offset + 1.2 * p.stepSize * Math.sin(stepAngle) + p.yo + L.HEIGHT
        const Ymax = p.yo + L.HEIGHT
        if (footy > Ymax) footy = Ymax
        const d = Math.sqrt((hipx - footx) * (hipx - footx) + (hipy - footy) * (hipy - footy)) || 0.0001
        const l = (L.L1 * L.L1 - L.L2 * L.L2 + d * d) / (2 * d)
        const h = Math.sqrt(Math.max(0, L.L1 * L.L1 - l * l))
        const kneex = (l / d) * (footx - hipx) - (h / d) * (footy - hipy) + hipx + offset
        const kneey = (l / d) * (footy - hipy) + (h / d) * (footx - hipx) + hipy
        return { hipx, hipy, kneex, kneey, footx, footy }
    },
    _drawLeg(p, leg, stroke, fillColor) {
        ctx.save()
        ctx.scale(p.flip, 1)
        // thigh + shin
        ctx.beginPath()
        ctx.moveTo(leg.hipx, leg.hipy); ctx.lineTo(leg.kneex, leg.kneey); ctx.lineTo(leg.footx, leg.footy)
        ctx.strokeStyle = stroke; ctx.lineWidth = 5; ctx.stroke()
        // toes (splayed when grounded, tucked when airborne)
        ctx.beginPath(); ctx.moveTo(leg.footx, leg.footy)
        if (p.og) {
            ctx.lineTo(leg.footx - 14, leg.footy + 5); ctx.moveTo(leg.footx, leg.footy); ctx.lineTo(leg.footx + 14, leg.footy + 5)
        } else {
            ctx.lineTo(leg.footx - 12, leg.footy + 8); ctx.moveTo(leg.footx, leg.footy); ctx.lineTo(leg.footx + 12, leg.footy + 8)
        }
        ctx.lineWidth = 4; ctx.stroke()
        // hip / knee / foot joints
        ctx.beginPath()
        ctx.arc(leg.hipx, leg.hipy, 9, 0, 2 * Math.PI)
        ctx.moveTo(leg.kneex + 5, leg.kneey); ctx.arc(leg.kneex, leg.kneey, 5, 0, 2 * Math.PI)
        ctx.moveTo(leg.footx + 4, leg.footy + 1); ctx.arc(leg.footx, leg.footy + 1, 4, 0, 2 * Math.PI)
        ctx.fillStyle = fillColor; ctx.fill(); ctx.lineWidth = 2; ctx.stroke()
        ctx.restore()
    },
    drawRemotePlayers() {
        for (const id in net.players) {
            const p = net.players[id]
            if (!p.al) continue
            if (simulation.cycle - p.lastSeen > 240) continue // stale -> hide
            p.rx += (p.x - p.rx) * net.SMOOTH
            p.ry += (p.y - p.ry) * net.SMOOTH
            // advance the walk animation locally, exactly like the host (walk_cycle += flipLegs * Vx)
            p.flip = (p.a > -Math.PI / 2 && p.a < Math.PI / 2) ? 1 : -1
            p.walk += p.flip * (p.vx || 0)
            p.stepSize = 0.8 * p.stepSize + 0.2 * (7 * Math.sqrt(Math.min(9, Math.abs(p.vx || 0))) * (p.og ? 1 : 0))
            const cFill = `hsl(${p.color.hue},${p.color.sat}%,${p.color.light}%)`
            const cDark = `hsl(${p.color.hue},${p.color.sat}%,${Math.max(0, p.color.light - 25)}%)`
            ctx.save()
            ctx.translate(p.rx, p.ry)
            // legs (rear then front), drawn before the body rotates — same as m.skin.defaultDraw
            net._drawLeg(p, net._calcLeg(p, Math.PI, -3), "#4a4a4a", cFill)
            net._drawLeg(p, net._calcLeg(p, 0, 0), "#333", cFill)
            // body + aim "eye", oriented to the player's look angle
            ctx.rotate(p.a)
            const grd = ctx.createLinearGradient(-30, 0, 30, 0)
            grd.addColorStop(0, cDark); grd.addColorStop(1, cFill)
            ctx.beginPath(); ctx.arc(0, 0, 30, 0, 2 * Math.PI)
            ctx.fillStyle = grd; ctx.fill()
            ctx.arc(15, 0, 4, 0, 2 * Math.PI)
            ctx.strokeStyle = "#333"; ctx.lineWidth = 2; ctx.stroke()
            ctx.restore()
            // energy field bubble (pulsing) when the field is up
            if (p.fo) {
                const pulse = 46 + 4 * Math.sin(simulation.cycle * 0.2)
                ctx.beginPath(); ctx.arc(p.rx, p.ry, pulse, 0, 2 * Math.PI)
                ctx.fillStyle = `hsla(${p.color.hue},100%,70%,0.06)`; ctx.fill()
                ctx.strokeStyle = `hsla(${p.color.hue},100%,70%,0.5)`; ctx.lineWidth = 3; ctx.stroke()
            }
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
