// ******************************************************************************************************
// Transport adapter — abstracts the realtime relay behind send()/onMessage() so the netcode in net.js
// doesn't care how bytes move.  Current backing: Supabase Realtime "broadcast" channels (works behind
// any NAT/firewall, no game server required — perfect for a static Vercel deploy).
// To swap to WebRTC/PeerJS later, implement the same 4 methods in a new class and point net.transport at it.
// ******************************************************************************************************
const SUPABASE_URL = "https://xfyijkztkhfkuffmjqwq.supabase.co"
const SUPABASE_KEY = "sb_publishable_A7d4oGNXwTaH8vIx7Jl94Q_D_dD6uFE"

let _supabaseClient = null
function getSupabaseClient() {
    if (_supabaseClient) return _supabaseClient
    _supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        realtime: { params: { eventsPerSecond: 40 } },
        auth: { persistSession: false, autoRefreshToken: false }
    })
    return _supabaseClient
}

class SupabaseTransport {
    constructor() {
        this.channel = null
        this.cb = {}
        this.peerId = null
        this.ready = false
    }

    connect(roomCode, callbacks) {
        this.cb = callbacks || {}
        const client = getSupabaseClient()
        this.peerId = net.myPeerId
        this.channel = client.channel("ngon-" + roomCode, {
            config: {
                broadcast: { self: false, ack: false },
                presence: { key: this.peerId }
            }
        })

        // game messages
        this.channel.on("broadcast", { event: "g" }, ({ payload }) => {
            if (this.cb.onMessage) this.cb.onMessage(payload)
        })

        // presence: detect players leaving (tab close / disconnect)
        this.channel.on("presence", { event: "leave" }, ({ leftPresences }) => {
            for (const pres of leftPresences || []) {
                const peer = pres.peer || pres.key
                if (peer && this.cb.onLeave) this.cb.onLeave(peer)
            }
        })

        this.channel.subscribe((status, err) => {
            if (status === "SUBSCRIBED") {
                this.ready = true
                this.channel.track({ peer: this.peerId, online_at: 0 })
                if (this.cb.onReady) this.cb.onReady()
            } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
                if (this.cb.onError) this.cb.onError(err ? (err.message || String(err)) : status)
            }
        })
    }

    send(obj) {
        if (!this.channel || !this.ready) return
        obj._from = this.peerId // stamp the sender so receivers can sanity-check claimed ids (relay has no auth)
        this.channel.send({ type: "broadcast", event: "g", payload: obj })
    }

    close() {
        if (this.channel) {
            try { this.channel.send({ type: "broadcast", event: "g", payload: { t: "bye", peer: this.peerId } }) } catch (e) { }
            try { this.channel.unsubscribe() } catch (e) { }
            this.channel = null
        }
        this.ready = false
    }
}
