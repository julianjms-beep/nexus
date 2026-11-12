pragma Singleton
import QtQuick

// Connection to nexus-sessiond (127.0.0.1:7779). The token path is the last "*.token" command-line argument.
QtObject {
    id: s
    readonly property string base: "http://127.0.0.1:7779"
    property string token: ""
    property bool connected: false
    property bool engineUp: false
    property var apps: ({})
    property var prefs: ({})
    property var tasks: []        // "Hoy" list: open tasks + the ones finished today
    property bool tasksLoaded: false  // the first answer arrived (until then "Hoy" shows no empty-state text)
    property var weather: null    // {city,temp,max,min,text,icon,glyph} or null when off/unknown
    onWallpaperChanged: Theme.wallLight = !!wallpaper && wallpaper.ink === "dark"
    // NEXUS Update (nexus-updated through nexus-sessiond): Ajustes → Actualizaciones. {unavailable:true} when it is down.
    property var update: null
    // the notification centre (nexus-sessiond keeps them on disk, newest first): nothing is lost when a toast fades,
    // No molestar is on or the shell restarts. `unread` is the bell's badge.
    property var notices: []
    property int unread: 0
    readonly property var recent: notices.slice(0, 8)
    function notice(d) {
        if (!d || !d.text) return
        if (d.id !== undefined) {
            var rest = notices.filter(function(n) { return n.id !== d.id })
            notices = [d].concat(rest).slice(0, 200)
            unread = notices.filter(function(n) { return !n.read }).length
        }
        if (prefs.dnd !== true || d.kind === "warn") toast(String(d.text), String(d.kind || "info"))
    }
    function refreshNotices() { request("GET", "/notices", null, function(st, j) { if (st === 200 && j) { s.notices = j.notices || []; s.unread = Number(j.unread) || 0 } }) }
    function readNotices(id) { request("POST", "/notices/read", id === undefined ? {} : { id: id }, function() { s.refreshNotices() }) }
    function deleteNotice(id) { request("POST", "/notices/delete", { id: id }, function() { s.refreshNotices() }) }
    function clearRecent() { request("POST", "/notices/clear", {}, function() { s.refreshNotices() }) }
    signal centerRequested()   // the bell: open the centre (Main.qml)
    // virtual desktops and every window, for the overview (nexus-sessiond keeps the book): {count, current, windows:[{line, app, appId, title, name, icon, focused, desktop}]}
    property var desktops: ({ count: 4, current: 1, windows: [] })
    function refreshDesktops() { request("GET", "/desktops", null, function(st, j) { if (st === 200 && j) s.desktops = j }) }
    function goToDesktop(to) { request("POST", "/desktop", { to: to }, function(st, j) { if (st === 200 && j) s.desktops = j }) }
    function windowOp(line, action, to) { request("POST", "/window", to === undefined ? { action: action, line: line } : { action: action, line: line, to: to }, function() { s.refreshDesktops() }) }
    // the shell's own health (Main.qml), sent now and again after every reconnect (a restarted nexus-sessiond)
    property var shellHealth: null
    function reportShell(parts, failed) { shellHealth = { parts: parts, failed: failed }; sendShellHealth() }
    function sendShellHealth() { if (shellHealth && token) request("POST", "/shell/health", shellHealth, null) }
    property bool wantUpdate: false   // only Ajustes asks for it (on start and after a reconnect)
    property var wallpaper: null  // what is on the desktop now (core/src/wallpaper.ts): {id,kind,file,color,ink,accent,fit,scrim}
    property var system: null
    property var history: []
    property var now: new Date()
    property int head: -1
    property bool polling: false
    property var queue: []
    property bool overlay: false   // a full-screen panel (NEXUS AI) is open: the wallpaper hides its clock
    readonly property bool aiConfigured: !!(system && system.engine && system.engine.ai && system.engine.ai.configured)
    readonly property bool clock24: prefs.clock24 !== false
    // the desktop: "barra" (one bar at the bottom, the panther: the default since 09-11) or "clasico" (top bar + dock)
    readonly property string layout: prefs.layout === "clasico" ? "clasico" : "barra"
    property var me: ({ user: "", name: "" })   // who is using this desktop (the start menu shows it)
    // the active window, for the menu bar (nexus-sessiond asks the compositor): {app (catalog id or ""), appId, title, name}
    property var focused: ({ app: "", appId: "", title: "", name: "" })

    signal uiRequested(string panel, string text)
    signal prefillRequested(string text)
    signal confirmRequested(string cid, string action, string reason, string origin)
    signal toast(string text, string kind)
    signal filesChanged()          // Archivos: something was binned, restored, renamed… (refresh the open windows)
    signal revealRequested(string path)  // Archivos: show this folder (NEXUS AI's "Enséñame 2026")
    signal foldersGone(var paths)        // Archivos: these folders were binned or removed (a window inside them moves up)
    signal automationsChanged()          // Automatizaciones: a rule or a run changed
    signal connectChanged()              // Conexiones: a service was connected or disconnected
    signal securityChanged()             // Ajustes → Privacidad y seguridad: a protection or the lock time changed
    signal automationDraftReady()        // Automatizaciones: NEXUS AI left a draft to review
    signal agentsChanged()               // Agentes: a profile, a run, its activity or an approval changed
    signal agentApproval(string id)      // Agentes: an agent is waiting for the person's click
    signal agencyChanged(string id)      // Agentes → Agencias: a team, a task or the board changed

    function openPanel(name) { panelLeft = -1; panelRight = -1; uiRequested(name, "") }
    // the menu bar's Wi-Fi, battery, Control Center and clock menus open under the icon that was clicked (screen x of
    // its edges; -1: at the right edge, as from the taskbar or the classic top bar)
    property real panelLeft: -1
    property real panelRight: -1
    function openPanelAt(name, item) {
        var p = item.mapToItem(null, 0, 0)
        panelLeft = p.x; panelRight = p.x + item.width
        uiRequested(name, "")
    }
    // set by the menu bar: a click on the bar while one of those menus covers the screen (x, y) → true when it hit a
    // status icon (which then opened its own menu); the menu that was open closes otherwise
    property var statusHit: null
    function askLocalConfirm(action) { confirmRequested("", action, "", "menu") }

    function tokenPath() {
        var a = Qt.application.arguments
        for (var i = a.length - 1; i >= 0; i--) if (String(a[i]).indexOf(".token") > 0) return String(a[i])
        return ""
    }
    function loadToken() {
        var p = tokenPath()
        if (!p) { console.warn("nexus: no session token path on the command line"); return }
        var x = new XMLHttpRequest()
        x.onreadystatechange = function() {
            if (x.readyState !== XMLHttpRequest.DONE) return
            var t = (x.responseText || "").trim()
            if (t.length >= 32) {
                s.token = t
                var q = s.queue; s.queue = []
                for (var i = 0; i < q.length; i++) s.request(q[i][0], q[i][1], q[i][2], q[i][3])
                s.begin()
            } else tokenRetry.restart()
        }
        x.open("GET", "file://" + p)
        x.send()
    }
    function request(method, path, body, cb) {
        if (!token) { queue.push([method, path, body, cb]); return }
        var x = new XMLHttpRequest()
        x.onreadystatechange = function() {
            if (x.readyState !== XMLHttpRequest.DONE) return
            if (x.status === 401) { s.token = ""; s.loadToken() }
            var j = null
            try { j = JSON.parse(x.responseText) } catch (e) {}
            if (cb) cb(x.status, j)
        }
        x.open(method, base + path)
        x.setRequestHeader("Authorization", "Bearer " + token)
        if (body !== undefined && body !== null) { x.setRequestHeader("Content-Type", "application/json"); x.send(JSON.stringify(body)) }
        else x.send()
    }
    function begin() { refreshMe(); refreshFocus(); refreshApps(); refreshPrefs(); refreshSystem(); refreshTasks(); refreshWeather(); refreshWallpaper(); refreshNotices(); refreshDesktops(); if (wantUpdate) refreshUpdate(); sendShellHealth(); if (!polling) poll() }
    function poll() {
        polling = true
        request("GET", "/events?since=" + head + "&wait=25000", null, function(st, j) {
            if (st === 200 && j) {
                s.connected = true
                var evs = j.events || []
                for (var i = 0; i < evs.length; i++) s.dispatch(evs[i])
                s.head = j.head
                s.poll()
            } else { s.connected = false; s.polling = false; s.head = -1; pollRetry.restart() }
        })
    }
    function dispatch(e) {
        var d = e.data || {}
        if (e.kind === "app") {
            var a = JSON.parse(JSON.stringify(apps))
            if (a[d.app]) { a[d.app].running = !!d.running; apps = a }
            if ((d.by === "ai" || d.by === "engine") && prefs.dnd !== true) toast("Abriendo " + ((a[d.app] || {}).name || d.app), "info")
        } else if (e.kind === "prefs") { prefs = d; applyPrefs() }
        else if (e.kind === "focus") focused = d
        else if (e.kind === "confirm") confirmRequested(String(d.id), String(d.action), String(d.reason || ""), "ai")
        else if (e.kind === "ui") { panelLeft = -1; panelRight = -1; uiRequested(String(d.panel), d.text ? String(d.text) : "") }
        else if (e.kind === "tasks") tasks = d.tasks || []
        else if (e.kind === "files") { filesChanged(); if (d.gone && d.gone.length) foldersGone(d.gone) }
        else if (e.kind === "reveal") revealRequested(String(d.path || ""))
        else if (e.kind === "notice") notice(d)
        else if (e.kind === "notices") refreshNotices()
        else if (e.kind === "desktops") desktops = d
        else if (e.kind === "automations") automationsChanged()
        else if (e.kind === "connect") connectChanged()
        else if (e.kind === "agents") agentsChanged()
        else if (e.kind === "agency") agencyChanged(String(e.data && e.data.id || ""))
        else if (e.kind === "agent-approval") agentApproval(String(e.data && e.data.id || ""))
        else if (e.kind === "automation-draft") automationDraftReady()
        else if (e.kind === "weather") weather = (d.off || d.temp === undefined) ? null : d
        else if (e.kind === "wallpaper") wallpaper = d
        else if (e.kind === "update") update = d
        else if (e.kind === "security") securityChanged()
        else if (e.kind === "engine") { engineUp = !!d.up; if (!d.up) toast("El motor de NEXUS se está reiniciando…", "warn") }
    }
    function applyPrefs() {
        Theme.dark = prefs.theme !== "light"
        if (prefs.accent) Theme.accent = prefs.accent
        Theme.motion = prefs.animations !== false
    }
    function refreshTasks() { request("GET", "/tasks", null, function(st, j) { if (st === 200 && j) { s.tasks = j.tasks || []; s.tasksLoaded = true } }) }
    function refreshUpdate() { request("GET", "/update", null, function(st, j) { s.update = st === 200 && j ? j : { unavailable: true, message: j && j.error ? String(j.error) : "" } }) }
    function updateAction(action, value, cb) {
        request("POST", "/update", value === undefined ? { action: action } : { action: action, value: value }, function(st, j) {
            if (st === 200 && j) s.update = j
            else if (st === 503) s.update = { unavailable: true, message: j && j.error ? String(j.error) : "" }
            if (cb) cb(st, j)
        })
    }
    function refreshWallpaper() { request("GET", "/wallpaper", null, function(st, j) { if (st === 200 && j) s.wallpaper = j }) }
    function nextWallpaper() { request("POST", "/wallpaper/next", {}, function(st, j) { if (st === 200 && j) s.wallpaper = j }) }
    function refreshWeather() { request("GET", "/weather", null, function(st, j) { if (st === 200 && j) s.weather = (j.off || j.temp === undefined) ? null : j }) }
    function setTaskDone(id, done) { request("POST", "/tasks/done", { id: id, done: done }, function() {}) }
    function deleteTask(id) { request("POST", "/tasks/delete", { id: id }, function() {}) }
    function prefill(text) { prefillRequested(text) }
    function refreshFocus() { request("GET", "/focus", null, function(st, j) { if (st === 200 && j) s.focused = j }) }
    // the menu bar's items: a shortcut pressed in the active window ("ctrl+c"), or a window action ("minimize"…)
    function sendKeys(keys) { request("POST", "/keys", { keys: keys }, null) }
    function windowAction(action) { request("POST", "/window", { action: action }, null) }
    function refreshMe() { request("GET", "/me", null, function(st, j) { if (st === 200 && j) s.me = j }) }
    function refreshApps() { request("GET", "/apps", null, function(st, j) { if (st === 200 && j) s.apps = j }) }
    function refreshPrefs() { request("GET", "/prefs", null, function(st, j) { if (st === 200 && j) { s.prefs = j; s.applyPrefs() } }) }
    function refreshSystem() { request("GET", "/system", null, function(st, j) { if (st === 200 && j) { s.system = j; s.engineUp = true } else if (st === 503) s.engineUp = false }) }
    function launch(id) { request("POST", "/launch", { app: id }, null) }
    function openSettings(page) { request("POST", "/launch", { app: "settings", page: page }, null) }   // Ajustes at that page
    function setPrefs(obj) { request("POST", "/prefs", obj, function(st, j) { if (st === 200 && j) { s.prefs = j; s.applyPrefs() } }) }
    function openFolder(path) { request("POST", "/launch", { app: "files", path: path }, null) }   // Archivos at that folder
    function power(action) { request("POST", "/power", { action: action }, null) }
    function confirm(cid, approve) { request("POST", "/confirm", { id: cid, approve: approve }, null) }
    function setPref(key, value) { var p = {}; p[key] = value; request("POST", "/prefs", p, function(st, j) { if (st === 200 && j) { s.prefs = j; s.applyPrefs() } }) }
    function ask(text, cb) {
        var hist = history.slice(-12)
        request("POST", "/ai", { text: text, history: hist }, function(st, j) {
            if (st === 200 && j) { s.history = hist.concat([{ role: "user", text: text }, { role: "assistant", text: String(j.text || "") }]); cb(true, j) }
            else cb(false, { text: st === 503 ? "El motor de NEXUS no responde ahora mismo. Vuelve a intentarlo en unos segundos." : "No he podido responder (error " + st + ").", actions: [] })
        })
    }

    property Timer tokenRetry: Timer { interval: 150; onTriggered: s.loadToken() }   // the shell starts alongside sessiond
    property Timer pollRetry: Timer { interval: 1500; onTriggered: s.begin() }
    property Timer sysTimer: Timer { interval: 3000; running: s.token !== ""; repeat: true; onTriggered: s.refreshSystem() }
    property Timer clock: Timer { interval: 1000; running: true; repeat: true; onTriggered: s.now = new Date() }
    Component.onCompleted: loadToken()
}
