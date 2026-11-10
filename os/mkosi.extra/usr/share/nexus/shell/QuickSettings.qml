import QtQuick
import QtQuick.Window
import org.kde.layershell 1.0 as LayerShell

// The menu bar's menus for this computer, as on a Mac (on 09-11 the person sent the macOS Wi-Fi menu, Battery menu and
// Control Center: "imagenes de como quiero vaya quedando el panel"). One layer-shell surface over the whole screen;
// `mode` picks the card, which opens under the icon that was clicked:
//   "control"  Centro de control (the sliders icon, the taskbar's button, the classic top bar): Wi-Fi, Bluetooth,
//              Modo avión, No molestar, Modo oscuro, Animaciones, Pantalla, Sonido, what is playing, Bajo consumo,
//              updates when there is news, «Editar controles…» (pref ccHidden), Ajustes / bloquear / apagar
//   "wifi"     Wi-Fi: on/off, the network in use, Redes conocidas, Otras redes (the password is typed in the row),
//              Ethernet, Ajustes de Wi-Fi…
//   "battery"  Batería: the charge, the power source, the time left, its health, Modo de energía
//   "notices"  under the clock: the date, the weather, the last notices, No molestar
// Everything is real: it reads and changes the hardware through nexus-sessiond (GET/POST /devices…: NetworkManager,
// BlueZ, PipeWire, power-profiles-daemon, core/src/devices.ts) and the same preferences as Ajustes. A Wi-Fi password
// only travels in the POST body to nexus-sessiond (127.0.0.1, with the session token) and is never kept here.
Window {
    id: qs
    visible: false
    color: "transparent"
    LayerShell.Window.scope: "nexus-quick"
    LayerShell.Window.layer: LayerShell.Window.LayerOverlay
    LayerShell.Window.anchors: LayerShell.Window.AnchorTop | LayerShell.Window.AnchorBottom | LayerShell.Window.AnchorLeft | LayerShell.Window.AnchorRight
    LayerShell.Window.exclusionZone: -1
    LayerShell.Window.keyboardInteractivity: LayerShell.Window.KeyboardInteractivityExclusive

    property bool shown: false
    property string mode: "control"
    property string from: ""            // "control": the Wi-Fi or battery menu was opened from the Control Center (← back)
    property real anchorLeft: -1        // the clicked icon's edges on screen (-1: the right edge of the screen)
    property real anchorRight: -1
    property bool editing: false        // Centro de control → Editar controles

    function open() {
        hideLater.stop(); visible = true; shown = true; requestActivate(); card.forceActiveFocus()
        Session.refreshUpdate(); refresh(); if (mode === "wifi") refreshWifi(true)
    }
    function close() { if (!shown) return; shown = false; askFor = ""; errFor = ""; editing = false; hideLater.restart() }
    function toggle() { toggleMode("control", -1, -1) }
    function toggleMode(m, left, right) {
        if (shown && mode === m) { close(); return }
        anchorLeft = left; anchorRight = right; from = ""
        if (!shown) { reset(); mode = m; open(); return }
        go(m); from = ""
    }
    function reset() { editing = false; askFor = ""; errFor = ""; othersOpen = false }
    function go(m) { from = mode; reset(); mode = m; refresh(); if (m === "wifi") refreshWifi(true); card.forceActiveFocus() }
    function goBack() { var f = from || "control"; from = ""; reset(); mode = f; card.forceActiveFocus() }
    Timer { id: hideLater; interval: Theme.ms(150) + 10; onTriggered: if (!qs.shown) qs.visible = false }

    // ---- the hardware, from nexus-sessiond
    property var dev: null              // GET /devices
    property var wl: null               // GET /devices/wifi: {networks, known, on, hardware}
    property var pendingWl: null        // a fresh list that arrived while a password was being typed (applied after)
    property bool scanning: false
    property string askFor: ""          // the network whose password is being typed
    property string connecting: ""
    property string errFor: ""
    property string errText: ""
    property bool othersOpen: false
    property double lastChange: 0       // a reading that started before the last change is old: ignored
    onAskForChanged: if (!askFor && pendingWl) { wl = pendingWl; pendingWl = null }

    readonly property var wifi: dev && dev.wifi ? dev.wifi : null
    readonly property bool wifiReady: !!wifi && wifi.available && wifi.hardware
    readonly property var bat: dev ? dev.battery : (Session.system ? Session.system.battery : null)
    readonly property var pw: dev && dev.power && dev.power.available ? dev.power : null
    readonly property var nets: wl && wl.networks ? wl.networks : []
    readonly property var curNet: {
        for (var i = 0; i < nets.length; i++) if (nets[i].current) return nets[i]
        return wifi && wifi.on && wifi.current ? wifi.current : null
    }
    readonly property var knownNets: nets.filter(function(n) { return n.known && !n.current })
    readonly property var otherNets: nets.filter(function(n) { return !n.known && !n.current }).slice(0, 14)
    readonly property bool othersShown: othersOpen || (!curNet && knownNets.length === 0)
    readonly property var hidden: Array.isArray(Session.prefs.ccHidden) ? Session.prefs.ccHidden : []
    function shows(id) { return hidden.indexOf(id) < 0 }
    readonly property var modeNames: ({ "power-saver": "Bajo consumo", "balanced": "Equilibrado", "performance": "Alto rendimiento" })

    function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1) }
    function dur(min) { var h = Math.floor(min / 60), m = Math.round(min % 60); return h ? h + " h " + (m < 10 ? "0" : "") + m + " min" : m + " min" }
    function ago(t) {
        var s = Math.max(0, Math.round((Session.now.getTime() - t) / 1000))
        return s < 60 ? "ahora" : s < 3600 ? "hace " + Math.round(s / 60) + " min" : Qt.formatTime(new Date(t), "HH:mm")
    }

    function refresh() {
        var t = Date.now()
        Session.request("GET", "/devices", null, function(st, j) { if (st === 200 && j && t >= qs.lastChange + 400) qs.dev = j })
    }
    // the list NetworkManager already has (instant), then a fresh scan (seconds) when `rescan`; a slower old answer
    // never replaces a newer one
    property int wifiSeq: 0
    property int wifiApplied: 0
    function refreshWifi(rescan) {
        if (rescan) { refreshWifi(false); scanning = true }
        var my = ++wifiSeq
        Session.request("GET", "/devices/wifi" + (rescan ? "?rescan=1" : ""), null, function(st, j) {
            if (rescan) qs.scanning = false
            if (st !== 200 || !j || my < qs.wifiApplied) return
            qs.wifiApplied = my
            if (qs.askFor) qs.pendingWl = j; else qs.wl = j
        })
    }
    Timer { interval: 3000; repeat: true; running: qs.shown; onTriggered: qs.refresh() }
    Timer { interval: 9000; repeat: true; running: qs.shown && qs.mode === "wifi" && !qs.connecting; onTriggered: qs.refreshWifi(false) }
    Timer { id: wifiLater; interval: 2500; onTriggered: qs.refreshWifi(true) }
    Timer { id: soon; interval: 700; onTriggered: qs.refresh() }

    // a change shows at once; the hardware's own reading follows
    function patch(path, value) {
        lastChange = Date.now()
        if (!dev) return
        var d = JSON.parse(JSON.stringify(dev)), o = d, k = path.split(".")
        for (var i = 0; i < k.length - 1; i++) { if (!o[k[i]]) return; o = o[k[i]] }
        o[k[k.length - 1]] = value
        dev = d
    }
    function post(path, body, done) {
        Session.request("POST", path, body, function(st, j) {
            if (st !== 200) { Session.notice(qs.cap(j && j.error ? j.error : "no se ha podido hacer"), "warn"); qs.lastChange = 0 }
            soon.restart()
            if (done) done(st, j)
        })
    }
    function setWifi(on) {
        patch("wifi.on", on)
        if (!on) { wl = null; askFor = "" }
        post("/devices/wifi", { on: on }, function(st) { if (st === 200 && on) wifiLater.restart() })
    }
    function setBluetooth(on) { patch("bluetooth.on", on); post("/devices/bluetooth", { on: on }) }
    function setAirplane(on) { patch("airplane.on", on); post("/devices/airplane", { on: on }) }
    function setPowerMode(m) { patch("power.mode", m); post("/devices/power", { mode: m }) }
    function media(a) { post("/devices/media", { action: a }) }
    // the sliders: at most one change every 120 ms while dragging, and the last one is always sent
    property real wantBright: -1
    property real wantVolume: -1
    function slideBright(v) { v = Math.round(v); patch("brightness.value", v); wantBright = v; if (!brTimer.running) brTimer.start() }
    function slideVolume(v) {
        v = Math.round(v)
        var unmute = !!(dev && dev.sound && dev.sound.muted)
        patch("sound.volume", v); if (unmute) patch("sound.muted", false)
        wantVolume = v; if (!volTimer.running) volTimer.start()
    }
    Timer { id: brTimer; interval: 120; onTriggered: if (qs.wantBright >= 0) { qs.post("/devices/brightness", { value: qs.wantBright }); qs.wantBright = -1 } }
    Timer { id: volTimer; interval: 120; onTriggered: if (qs.wantVolume >= 0) { qs.post("/devices/sound", { volume: qs.wantVolume, muted: false }); qs.wantVolume = -1 } }

    // Wi-Fi: a saved or open network connects at once; a new one with a password asks for it in its row
    function pick(net) {
        if (connecting || net.current) return
        if (net.secure && !net.known) { askFor = askFor === net.ssid ? "" : net.ssid; errFor = ""; return }
        connectTo(net)
    }
    function connectTo(net, password) {
        connecting = net.ssid; errFor = ""; errText = ""
        var b = { ssid: net.ssid }
        if (password !== undefined) b.password = password
        Session.request("POST", "/devices/wifi/connect", b, function(st, j) {
            qs.connecting = ""
            if (st === 200) { qs.askFor = ""; qs.lastChange = 0; qs.refresh(); qs.refreshWifi(false); return }
            qs.errText = qs.cap(j && j.error ? j.error : "no se ha podido conectar")
            qs.errFor = net.ssid
            if (st === 401) qs.askFor = net.ssid
        })
    }
    function disconnectWifi() { post("/devices/wifi/disconnect", {}, function() { qs.refreshWifi(false) }) }
    function forget(ssid) { post("/devices/wifi/forget", { ssid: ssid }, function() { qs.refreshWifi(false) }) }

    function batTime(b) {
        if (!b) return ""
        if (b.status === "Full") return "Cargada"
        if (b.status === "Charging") return b.minutesToFull ? "Cargada del todo en " + dur(b.minutesToFull) : "Cargando…"
        if (b.onAc) return "Enchufado (no está cargando ahora)"
        return b.minutesToEmpty ? "Quedan " + dur(b.minutesToEmpty) : "Calculando el tiempo que queda…"
    }
    readonly property var up: Session.update
    readonly property string upState: !up || up.unavailable ? "" : String(up.state || "idle")
    readonly property bool upNews: ["available", "ready", "reboot", "error", "downloading", "installing", "verifying"].indexOf(upState) >= 0
    function upText() {
        var v = up && up.available ? up.available.version : ""
        return ({
            available: "NEXUS OS " + v + " disponible",
            downloading: "Descargando NEXUS OS " + v + "… " + Math.round((up && up.progress || 0) * 100) + " %",
            ready: "NEXUS OS " + v + " lista para instalar",
            installing: "Instalando NEXUS OS " + v + "…",
            verifying: "Comprobando la nueva versión…",
            reboot: "Reinicia para terminar",
            error: "La última actualización no salió bien"
        })[upState] || ""
    }

    // ---- pieces (inline components see only Theme, Session and their own properties)
    component Tile: Rectangle {
        radius: 12
        color: Theme.dark ? Qt.rgba(1, 1, 1, 0.075) : Qt.rgba(1, 1, 1, 0.82)
        border.color: Theme.dark ? Qt.rgba(1, 1, 1, 0.07) : Qt.rgba(0, 0, 0, 0.07)
    }
    // a round icon: filled with the accent when on (the Mac's blue circles)
    component Dot: Rectangle {
        id: d
        property bool on: false
        property string icon: ""
        property bool wifiGlyph: false
        property int bars: 3
        property bool faded: false
        property bool interactive: true
        signal clicked()
        width: 28; height: 28; radius: 14
        color: on ? Theme.accent : (Theme.dark ? Qt.rgba(1, 1, 1, 0.15) : Qt.rgba(0, 0, 0, 0.09))
        opacity: faded ? 0.45 : 1
        scale: dma.pressed ? 0.9 : 1
        Behavior on color { ColorAnimation { duration: Theme.ms(140) } }
        Behavior on scale { NumberAnimation { duration: Theme.ms(100); easing.type: Easing.OutCubic } }
        LineIcon { visible: !d.wifiGlyph && d.icon !== ""; anchors.centerIn: parent; name: d.icon; size: 15; stroke: 1.9; color: d.on ? "#ffffff" : Theme.text }
        WifiGlyph { visible: d.wifiGlyph; anchors.centerIn: parent; anchors.verticalCenterOffset: 1; width: 15; height: 11.7; bars: d.bars; color: d.on ? "#ffffff" : Theme.text }
        MouseArea { id: dma; anchors.fill: parent; enabled: d.interactive; cursorShape: Qt.PointingHandCursor; onClicked: d.clicked() }
    }
    // a row of the connectivity tile: the circle switches it, the words open its menu (Wi-Fi)
    component ConnRow: Item {
        id: cr
        property bool on: false
        property string icon: ""
        property bool wifiGlyph: false
        property string title: ""
        property string sub: ""
        property bool more: false
        signal toggled()
        signal opened()
        width: parent ? parent.width : 0
        height: 36
        Dot { anchors.verticalCenter: parent.verticalCenter; on: cr.on; icon: cr.icon; wifiGlyph: cr.wifiGlyph; onClicked: cr.toggled() }
        Column {
            x: 36; anchors.verticalCenter: parent.verticalCenter
            width: parent.width - 36
            Text { width: parent.width; elide: Text.ElideRight; text: cr.title; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
            Text { width: parent.width; elide: Text.ElideRight; text: cr.sub; color: Theme.dim; font.family: Theme.font; font.pixelSize: 11 }
        }
        MouseArea { x: 34; width: parent.width - 34; height: parent.height; cursorShape: Qt.PointingHandCursor; onClicked: cr.more ? cr.opened() : cr.toggled() }
    }
    // a small square tile: an icon over its name
    component SmallTile: Rectangle {
        id: stl
        property bool on: false
        property string icon: ""
        property string label: ""
        signal clicked()
        height: 68; radius: 12
        color: Theme.dark ? (sma.containsMouse ? Qt.rgba(1, 1, 1, 0.11) : Qt.rgba(1, 1, 1, 0.075)) : (sma.containsMouse ? "#ffffff" : Qt.rgba(1, 1, 1, 0.82))
        border.color: Theme.dark ? Qt.rgba(1, 1, 1, 0.07) : Qt.rgba(0, 0, 0, 0.07)
        Dot { anchors.horizontalCenter: parent.horizontalCenter; y: 7; on: stl.on; icon: stl.icon; interactive: false }
        Text {   // two short lines when the name does not fit in one ("Modo / oscuro"), as on a Mac
            anchors.horizontalCenter: parent.horizontalCenter; y: 38
            width: parent.width - 8; horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap; maximumLineCount: 2; lineHeight: 0.92
            fontSizeMode: Text.HorizontalFit; minimumPixelSize: 9   // one long word ("Animaciones") shrinks a little
            text: stl.label; color: Theme.text; font.family: Theme.font; font.pixelSize: 11
        }
        MouseArea { id: sma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: stl.clicked() }
    }
    // the Mac's slider: a white fill with its knob, the icon inside the track
    component Slider: Item {
        id: sl
        property real value: 0
        property string icon: "sun"
        signal moved(real v)
        readonly property bool dragging: slma.pressed
        property real local: 0
        readonly property real at: Math.max(0, Math.min(100, dragging ? local : value))
        height: 24
        Rectangle {
            anchors.fill: parent; radius: height / 2
            color: Theme.dark ? Qt.rgba(1, 1, 1, 0.14) : Qt.rgba(0, 0, 0, 0.13)
            Rectangle {
                height: parent.height; radius: height / 2
                width: height + (parent.width - height) * sl.at / 100
                color: "#ffffff"
                border.color: Theme.dark ? "transparent" : Qt.rgba(0, 0, 0, 0.12)   // white on a light tile needs an edge
                Rectangle {
                    anchors.right: parent.right
                    width: parent.height; height: parent.height; radius: height / 2
                    color: "#ffffff"; border.color: Qt.rgba(0, 0, 0, 0.16)
                }
            }
            LineIcon { x: 5; anchors.verticalCenter: parent.verticalCenter; name: sl.icon; size: 14; stroke: 1.9; color: "#5b6382" }
        }
        MouseArea {
            id: slma
            anchors.fill: parent; anchors.margins: -4
            cursorShape: Qt.PointingHandCursor
            function pos(mx) { return Math.max(0, Math.min(100, (mx - 4 - sl.height / 2) / Math.max(1, sl.width - sl.height) * 100)) }
            onPressed: (m) => { sl.local = pos(m.x); sl.moved(sl.local) }
            onPositionChanged: (m) => { if (pressed) { sl.local = pos(m.x); sl.moved(sl.local) } }
        }
    }
    // a line of a menu (the Mac's: the accent under the pointer, white text), with an optional tick or chevron
    component MenuItem: Item {
        id: mi
        property string label: ""
        property string hint: ""
        property bool checkable: false
        property bool checked: false
        property bool chevron: false
        property bool open: false
        signal clicked()
        width: parent ? parent.width : 0
        height: 28
        readonly property bool hot: mima.containsMouse
        Rectangle { anchors.fill: parent; radius: 6; color: mi.hot ? Theme.accent : "transparent" }
        LineIcon { visible: mi.checkable && mi.checked; x: 9; anchors.verticalCenter: parent.verticalCenter; name: "check"; size: 13; stroke: 2.2; color: mi.hot ? "#ffffff" : Theme.text }
        Text {
            x: mi.checkable ? 28 : 10; anchors.verticalCenter: parent.verticalCenter
            width: parent.width - x - (hintT.text ? hintT.implicitWidth + 16 : 0) - (mi.chevron ? 24 : 8); elide: Text.ElideRight
            text: mi.label; color: mi.hot ? "#ffffff" : Theme.text; font.family: Theme.font; font.pixelSize: 13
        }
        Text {
            id: hintT
            anchors.right: parent.right; anchors.rightMargin: mi.chevron ? 26 : 10; anchors.verticalCenter: parent.verticalCenter
            text: mi.hint; color: mi.hot ? Qt.rgba(1, 1, 1, 0.8) : Theme.faint; font.family: Theme.font; font.pixelSize: 12
        }
        LineIcon {
            visible: mi.chevron
            anchors.right: parent.right; anchors.rightMargin: 8; anchors.verticalCenter: parent.verticalCenter
            name: "forward"; size: 13; stroke: 2; color: mi.hot ? "#ffffff" : Theme.dim
            rotation: mi.open ? 90 : 0
            Behavior on rotation { NumberAnimation { duration: Theme.ms(140) } }
        }
        MouseArea { id: mima; anchors.fill: parent; hoverEnabled: true; onClicked: mi.clicked() }
    }
    component Head: Text {
        x: 10
        color: Theme.dim; font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold
        topPadding: 6; bottomPadding: 2
    }
    component Sep: Rectangle {
        x: 8; width: parent ? parent.width - 16 : 0; height: 1
        color: Theme.dark ? Qt.rgba(1, 1, 1, 0.1) : Qt.rgba(0, 0, 0, 0.1)
    }
    // a menu's title line: ← back (when it came from the Control Center), the name, something on the right
    component Title: Item {
        id: tt
        property string text: ""
        property bool back: false
        signal backClicked()
        default property alias trailing: rbox.data
        width: parent ? parent.width : 0
        height: 34
        Rectangle {
            visible: tt.back
            x: 4; anchors.verticalCenter: parent.verticalCenter
            width: 24; height: 24; radius: 6
            color: bma.containsMouse ? Theme.hover : "transparent"
            LineIcon { anchors.centerIn: parent; name: "back"; size: 14; stroke: 2.2; color: Theme.text }
            MouseArea { id: bma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: tt.backClicked() }
        }
        Text { x: tt.back ? 32 : 10; anchors.verticalCenter: parent.verticalCenter; text: tt.text; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.Bold }
        Item { id: rbox; anchors.right: parent.right; anchors.rightMargin: 10; height: parent.height; width: childrenRect.width }
    }

    // a Wi-Fi network: its circle (the accent when it is the one in use), the name, a lock; the password is typed here
    component NetRow: Item {
        id: nr
        property var net: ({})
        property bool connecting: false
        property bool asking: false
        property string err: ""
        signal picked()
        signal submit(string password)
        signal cancel()
        signal forget()
        signal disconnect()
        width: parent ? parent.width : 0
        height: 36 + (extra.visible ? extra.height + 8 : 0)
        onAskingChanged: if (asking) pwIn.forceActiveFocus()
        readonly property bool hot: nma.containsMouse || lma.containsMouse
        Rectangle {
            y: 2; width: parent.width; height: 32; radius: 6
            color: nr.hot && !nr.net.current ? (Theme.dark ? Qt.rgba(1, 1, 1, 0.09) : Qt.rgba(0, 0, 0, 0.06)) : "transparent"
        }
        Dot { x: 6; y: 4; on: !!nr.net.current; wifiGlyph: true; bars: nr.net.bars || 1; interactive: false }
        Text {
            x: 42; y: 2; height: 32; verticalAlignment: Text.AlignVCenter
            width: parent.width - 42 - right.width - 14; elide: Text.ElideRight
            text: nr.net.ssid || ""; color: Theme.text; font.family: Theme.font; font.pixelSize: 13
            font.weight: nr.net.current ? Font.DemiBold : Font.Normal
        }
        MouseArea { id: nma; y: 2; width: parent.width; height: 32; hoverEnabled: true; cursorShape: nr.net.current ? Qt.ArrowCursor : Qt.PointingHandCursor; onClicked: nr.picked() }
        Row {
            id: right
            anchors.right: parent.right; anchors.rightMargin: 10
            y: 2; height: 32
            spacing: 8
            LineIcon {
                visible: nr.connecting
                anchors.verticalCenter: parent.verticalCenter
                name: "restart"; size: 14; color: Theme.dim
                RotationAnimator on rotation { from: 0; to: 360; duration: 900; loops: Animation.Infinite; running: nr.connecting }
            }
            Text {   // the network in use: Desconectar; a saved one: Olvidar (shown under the pointer)
                visible: nr.hot && !nr.connecting && (!!nr.net.current || !!nr.net.known)
                anchors.verticalCenter: parent.verticalCenter
                text: nr.net.current ? "Desconectar" : "Olvidar"
                color: lma.containsMouse ? Theme.accent : Theme.dim
                font.family: Theme.font; font.pixelSize: 12; font.underline: lma.containsMouse
                MouseArea { id: lma; anchors.fill: parent; anchors.margins: -4; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: nr.net.current ? nr.disconnect() : nr.forget() }
            }
            LineIcon {
                visible: !!nr.net.secure && !(nr.hot && (!!nr.net.current || !!nr.net.known)) && !nr.connecting
                anchors.verticalCenter: parent.verticalCenter
                name: "lock"; size: 13; stroke: 1.8; color: Theme.dim
            }
        }
        Column {
            id: extra
            visible: nr.asking || nr.err !== ""
            x: 42; y: 38
            width: parent.width - 52
            spacing: 6
            Text {
                visible: nr.err !== ""
                width: parent.width; wrapMode: Text.Wrap
                text: nr.err; color: Theme.danger; font.family: Theme.font; font.pixelSize: 12
            }
            Row {
                visible: nr.asking
                spacing: 6
                Rectangle {
                    width: extra.width - goBtn.width - 6; height: 28; radius: 7
                    color: Theme.dark ? Qt.rgba(0, 0, 0, 0.28) : "#ffffff"
                    border.color: pwIn.activeFocus ? Theme.accent : Theme.border
                    TextInput {
                        id: pwIn
                        x: 9; width: parent.width - 18; anchors.verticalCenter: parent.verticalCenter
                        echoMode: TextInput.Password; passwordCharacter: "•"
                        enabled: !nr.connecting
                        color: Theme.text; selectionColor: Theme.accent
                        font.family: Theme.font; font.pixelSize: 13
                        clip: true; selectByMouse: true; maximumLength: 64
                        function go() { if (text.length) { var t = text; text = ""; nr.submit(t) } }
                        Keys.onReturnPressed: go()
                        Keys.onEnterPressed: go()
                        Keys.onEscapePressed: { text = ""; nr.cancel() }
                    }
                    Text {
                        visible: pwIn.text === ""
                        x: 9; anchors.verticalCenter: parent.verticalCenter
                        text: nr.connecting ? "Conectando…" : "Contraseña"
                        color: Theme.faint; font.family: Theme.font; font.pixelSize: 13
                    }
                }
                Rectangle {
                    id: goBtn
                    width: goT.implicitWidth + 20; height: 28; radius: 7
                    color: gma.containsMouse ? Qt.lighter(Theme.accent, 1.1) : Theme.accent
                    opacity: pwIn.text.length >= 8 && !nr.connecting ? 1 : 0.5
                    Text { id: goT; anchors.centerIn: parent; text: "Conectar"; color: "#ffffff"; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
                    MouseArea { id: gma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: pwIn.go() }
                }
            }
        }
    }

    // a click outside closes; on the menu bar, another of its icons opens its own menu in place
    MouseArea {
        anchors.fill: parent
        onClicked: (m) => { if (Session.statusHit && Session.statusHit(m.x, m.y)) return; qs.close() }
    }

    Rectangle {
        id: card
        readonly property bool rightAligned: qs.mode === "control" || qs.mode === "notices" || qs.from === "control"
        width: qs.mode === "control" ? 344 : qs.mode === "notices" ? 360 : 304
        x: {
            var want = qs.anchorRight < 0 ? qs.width - width - 10 : rightAligned ? qs.anchorRight - width : qs.anchorLeft
            return Math.max(8, Math.min(qs.width - width - 8, want))
        }
        // under the menu bar ("barra": 30 + 4), or under the classic top bar
        y: Session.layout === "barra" ? 34 : 60
        readonly property Item page: qs.mode === "wifi" ? wifiPage : qs.mode === "battery" ? batPage : qs.mode === "notices" ? notPage : ccPage
        height: page.y + page.height + (qs.mode === "control" || qs.mode === "notices" ? 12 : 6)
        radius: 14
        clip: true
        color: Theme.dark ? Qt.rgba(0.1, 0.11, 0.145, 0.97) : Qt.rgba(0.955, 0.96, 0.975, 0.98)
        border.color: Theme.dark ? Qt.rgba(1, 1, 1, 0.12) : Qt.rgba(0, 0, 0, 0.12)
        focus: true
        Keys.onEscapePressed: {
            if (qs.askFor) { qs.askFor = ""; qs.errFor = "" }
            else if (qs.editing) qs.editing = false
            else if (qs.from) qs.goBack()
            else qs.close()
        }
        opacity: qs.shown ? 1 : 0
        scale: qs.shown ? 1 : 0.96
        transformOrigin: rightAligned ? Item.TopRight : Item.TopLeft
        Behavior on opacity { NumberAnimation { duration: Theme.ms(qs.shown ? 160 : 120); easing.type: Easing.OutCubic } }
        Behavior on scale { NumberAnimation { duration: Theme.ms(qs.shown ? 220 : 120); easing.type: Easing.OutCubic } }
        Behavior on height { enabled: qs.shown; NumberAnimation { duration: Theme.ms(150); easing.type: Easing.OutCubic } }
        MouseArea { anchors.fill: parent }

        // ================= Centro de control
        Column {
            id: ccPage
            visible: qs.mode === "control"
            x: 12; y: 12
            width: parent.width - 24
            spacing: 10

            // connectivity (left) · No molestar, Modo oscuro, Animaciones (right)
            Item {
                visible: !qs.editing
                width: parent.width
                height: Math.max(conn.height, rightCol.visible ? rightCol.height : 0)
                Tile {
                    id: conn
                    width: rightCol.visible ? (parent.width - 10) / 2 : parent.width
                    height: Math.max(connRows.height + 16, rightCol.visible ? rightCol.height : 0)
                    Column {
                        id: connRows
                        x: 10; y: (parent.height - height) / 2
                        width: parent.width - 20
                        spacing: 4
                        ConnRow {   // Wi-Fi (or the cable, on a computer without Wi-Fi; or the plain network state)
                            readonly property var eth: qs.wifi ? qs.wifi.ethernet : null
                            readonly property bool useWifi: qs.wifiReady
                            wifiGlyph: useWifi || !eth
                            icon: "ethernet"
                            on: useWifi ? qs.wifi.on : eth ? eth.connected : !!(Session.system && Session.system.online)
                            title: useWifi ? "Wi-Fi" : eth ? "Ethernet" : "Red"
                            sub: useWifi ? (!qs.wifi.on ? "Desactivado" : qs.curNet ? qs.curNet.ssid : "Sin conectar")
                                 : eth ? (eth.connected ? "Conectado" : "Sin cable")
                                 : Session.system && Session.system.online ? "Conectado" : "Sin red"
                            more: true
                            onToggled: if (useWifi) qs.setWifi(!qs.wifi.on); else qs.go("wifi")
                            onOpened: qs.go("wifi")
                        }
                        ConnRow {
                            visible: !!qs.dev && qs.dev.bluetooth.available
                            icon: "bluetooth"
                            on: !!qs.dev && qs.dev.bluetooth.on
                            title: "Bluetooth"
                            sub: {
                                if (!qs.dev || !qs.dev.bluetooth.on) return "Desactivado"
                                var c = (qs.dev.bluetooth.devices || []).filter(function(x) { return x.connected })
                                return c.length ? c.map(function(x) { return x.name || x.mac }).join(", ") : "Activado"
                            }
                            onToggled: qs.setBluetooth(!on)
                        }
                        ConnRow {
                            visible: !!qs.dev && qs.dev.airplane.available
                            icon: "airplane"
                            on: !!qs.dev && qs.dev.airplane.on
                            title: "Modo avión"
                            sub: on ? "Activado" : "Desactivado"
                            onToggled: qs.setAirplane(!on)
                        }
                    }
                }
                Column {
                    id: rightCol
                    visible: qs.shows("concentracion") || qs.shows("oscuro") || qs.shows("animaciones")
                    anchors.right: parent.right
                    width: (parent.width - 10) / 2
                    spacing: 10
                    Tile {
                        visible: qs.shows("concentracion")
                        width: parent.width; height: 62
                        readonly property bool on: Session.prefs.dnd === true
                        Dot { x: 10; anchors.verticalCenter: parent.verticalCenter; on: parent.on; icon: "moon"; interactive: false }
                        Column {
                            x: 46; anchors.verticalCenter: parent.verticalCenter
                            width: parent.width - 52
                            Text { width: parent.width; elide: Text.ElideRight; text: "No molestar"; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
                            Text { width: parent.width; elide: Text.ElideRight; text: parent.parent.on ? "Activado" : "Desactivado"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 11 }
                        }
                        MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: Session.setPref("dnd", !parent.on) }
                    }
                    Row {
                        id: smalls
                        visible: qs.shows("oscuro") || qs.shows("animaciones")
                        width: parent.width
                        spacing: 10
                        readonly property int count: (qs.shows("oscuro") ? 1 : 0) + (qs.shows("animaciones") ? 1 : 0)
                        SmallTile {
                            visible: qs.shows("oscuro")
                            width: (smalls.width - (smalls.count - 1) * 10) / smalls.count
                            on: Theme.dark; icon: "contrast"; label: "Modo oscuro"
                            onClicked: Session.setPref("theme", Theme.dark ? "light" : "dark")
                        }
                        SmallTile {
                            visible: qs.shows("animaciones")
                            width: (smalls.width - (smalls.count - 1) * 10) / smalls.count
                            on: Session.prefs.animations !== false; icon: "sparkle"; label: "Animaciones"
                            onClicked: Session.setPref("animations", !on)
                        }
                    }
                }
            }

            Tile {   // Pantalla
                visible: !qs.editing && qs.shows("pantalla") && !!qs.dev && qs.dev.brightness.available
                width: parent.width; height: 64
                Text { x: 12; y: 10; text: "Pantalla"; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
                Slider {
                    x: 12; y: 31; width: parent.width - 24
                    icon: "sun"
                    value: qs.dev ? qs.dev.brightness.value : 0
                    onMoved: (v) => qs.slideBright(v)
                }
            }
            Tile {   // Sonido
                visible: !qs.editing && qs.shows("sonido") && !!qs.dev && qs.dev.sound.available
                width: parent.width; height: 64
                Text { x: 12; y: 10; text: "Sonido"; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
                Text {
                    visible: !!qs.dev && qs.dev.sound.muted
                    anchors.right: parent.right; anchors.rightMargin: 12; y: 11
                    text: "Silenciado"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 11
                }
                Slider {
                    x: 12; y: 31; width: parent.width - 24
                    icon: !qs.dev || qs.dev.sound.muted || qs.dev.sound.volume === 0 ? "speaker-off" : "speaker"
                    value: !qs.dev ? 0 : qs.dev.sound.muted ? 0 : qs.dev.sound.volume
                    onMoved: (v) => qs.slideVolume(v)
                }
            }
            Tile {   // what is playing (any app that speaks MPRIS: the browser, a music player…)
                readonly property var md: qs.dev ? qs.dev.media : null
                visible: !qs.editing && qs.shows("musica") && !!md && md.status !== "Stopped"
                width: parent.width; height: 60
                Rectangle {
                    x: 10; anchors.verticalCenter: parent.verticalCenter
                    width: 40; height: 40; radius: 9
                    color: Theme.alpha(Theme.accent, 0.22)
                    LineIcon { anchors.centerIn: parent; name: "music"; size: 19; color: Theme.accent }
                }
                Column {
                    x: 60; anchors.verticalCenter: parent.verticalCenter
                    width: parent.width - 60 - mediaBtns.width - 16
                    Text { width: parent.width; elide: Text.ElideRight; text: parent.parent.md ? (parent.parent.md.title || "Reproduciendo") : ""; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
                    Text { width: parent.width; elide: Text.ElideRight; text: parent.parent.md ? (parent.parent.md.artist || parent.parent.md.player) : ""; color: Theme.dim; font.family: Theme.font; font.pixelSize: 11 }
                }
                Row {
                    id: mediaBtns
                    anchors.right: parent.right; anchors.rightMargin: 8; anchors.verticalCenter: parent.verticalCenter
                    spacing: 2
                    Repeater {
                        model: [["previous", "previous"], ["play-pause", ""], ["next", "next"]]
                        Rectangle {
                            required property var modelData
                            width: 30; height: 30; radius: 15
                            color: mbma.containsMouse ? Theme.hover : "transparent"
                            LineIcon {
                                anchors.centerIn: parent; size: 15; stroke: 1.6; filled: true; color: Theme.text
                                name: modelData[1] || (qs.dev && qs.dev.media && qs.dev.media.status === "Playing" ? "pause" : "play")
                            }
                            MouseArea { id: mbma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: qs.media(modelData[0]) }
                        }
                    }
                }
            }
            Tile {   // Bajo consumo (power-profiles-daemon); its words open the whole battery menu
                readonly property bool on: !!qs.pw && qs.pw.mode === "power-saver"
                visible: !qs.editing && qs.shows("energia") && !!qs.pw && qs.pw.modes.indexOf("power-saver") >= 0
                width: parent.width; height: 50
                Dot { x: 10; anchors.verticalCenter: parent.verticalCenter; on: parent.on; icon: "bolt"; onClicked: qs.setPowerMode(parent.on ? "balanced" : "power-saver") }
                Column {
                    x: 46; anchors.verticalCenter: parent.verticalCenter
                    Text { text: "Bajo consumo"; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
                    Text { text: qs.pw ? "Modo de energía: " + (qs.modeNames[qs.pw.mode] || qs.pw.mode) : ""; color: Theme.dim; font.family: Theme.font; font.pixelSize: 11 }
                }
                LineIcon { anchors.right: parent.right; anchors.rightMargin: 12; anchors.verticalCenter: parent.verticalCenter; name: "forward"; size: 13; stroke: 2; color: Theme.dim }
                MouseArea { x: 44; width: parent.width - 44; height: parent.height; cursorShape: Qt.PointingHandCursor; onClicked: qs.go("battery") }
            }
            Tile {   // updates, only when there is news
                visible: !qs.editing && qs.upNews
                width: parent.width; height: 50
                color: uma.containsMouse ? (Theme.dark ? Qt.rgba(1, 1, 1, 0.11) : "#ffffff") : (Theme.dark ? Qt.rgba(1, 1, 1, 0.075) : Qt.rgba(1, 1, 1, 0.82))
                Dot { x: 10; anchors.verticalCenter: parent.verticalCenter; on: true; icon: "update"; interactive: false }
                Column {
                    x: 46; anchors.verticalCenter: parent.verticalCenter
                    width: parent.width - 60
                    Text { text: "Actualizaciones"; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
                    Text {
                        width: parent.width; elide: Text.ElideRight
                        text: qs.upText()
                        color: qs.upState === "reboot" || qs.upState === "error" ? Theme.warn : Theme.dim; font.family: Theme.font; font.pixelSize: 11
                    }
                }
                MouseArea { id: uma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: { qs.close(); Session.openSettings("actualizaciones") } }
            }

            // «Editar controles…»: which tiles show (Wi-Fi, Bluetooth and Modo avión always do)
            Column {
                visible: qs.editing
                width: parent.width
                spacing: 2
                Text { x: 4; text: "Editar controles"; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.Bold; bottomPadding: 2 }
                Text {
                    x: 4; width: parent.width - 8; wrapMode: Text.Wrap; bottomPadding: 6
                    text: "Marca lo que quieres ver en el Centro de control. El Wi‑Fi, el Bluetooth y el Modo avión se ven siempre."
                    color: Theme.dim; font.family: Theme.font; font.pixelSize: 12
                }
                Repeater {
                    model: [["concentracion", "No molestar"], ["oscuro", "Modo oscuro"], ["animaciones", "Animaciones"], ["pantalla", "Pantalla (brillo)"],
                            ["sonido", "Sonido (volumen)"], ["musica", "Lo que suena"], ["energia", "Bajo consumo"]]
                    MenuItem {
                        required property var modelData
                        label: modelData[1]
                        checkable: true
                        checked: qs.shows(modelData[0])
                        onClicked: {
                            var h = qs.hidden.slice(), i = h.indexOf(modelData[0])
                            if (i >= 0) h.splice(i, 1); else h.push(modelData[0])
                            Session.setPref("ccHidden", h)
                        }
                    }
                }
            }
            Rectangle {
                anchors.horizontalCenter: parent.horizontalCenter
                width: edT.implicitWidth + 26; height: 28; radius: 14
                color: ema.containsMouse ? (Theme.dark ? Qt.rgba(1, 1, 1, 0.13) : "#ffffff") : (Theme.dark ? Qt.rgba(1, 1, 1, 0.075) : Qt.rgba(1, 1, 1, 0.82))
                border.color: Theme.dark ? Qt.rgba(1, 1, 1, 0.07) : Qt.rgba(0, 0, 0, 0.07)
                Text { id: edT; anchors.centerIn: parent; text: qs.editing ? "Listo" : "Editar controles…"; color: Theme.text; font.family: Theme.font; font.pixelSize: 12 }
                MouseArea { id: ema; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: qs.editing = !qs.editing }
            }

            // Ajustes, bloquear, apagar
            Item {
                width: parent.width; height: 38
                Rectangle {
                    width: st.implicitWidth + 46; height: 34; radius: 10
                    anchors.verticalCenter: parent.verticalCenter
                    color: sa.containsMouse ? Theme.hover : "transparent"
                    LineIcon { x: 10; anchors.verticalCenter: parent.verticalCenter; name: "gear"; size: 17; stroke: 1.7; color: Theme.text }
                    Text { id: st; x: 34; anchors.verticalCenter: parent.verticalCenter; text: "Ajustes"; color: Theme.text; font.family: Theme.font; font.pixelSize: 13 }
                    MouseArea { id: sa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: { qs.close(); Session.launch("settings") } }
                }
                Row {
                    anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                    spacing: 4
                    Rectangle {
                        width: 34; height: 34; radius: 10
                        color: la.containsMouse ? Theme.hover : "transparent"
                        LineIcon { anchors.centerIn: parent; name: "lock"; size: 17; color: Theme.text }
                        MouseArea { id: la; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: { qs.close(); Session.power("lock") } }
                    }
                    Rectangle {
                        width: 34; height: 34; radius: 10
                        color: pa.containsMouse ? Theme.hover : "transparent"
                        PowerGlyph { anchors.centerIn: parent; width: 15; height: 15; color: Theme.text }
                        MouseArea { id: pa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: Session.openPanel("power") }
                    }
                }
            }
        }

        // ================= Wi-Fi
        Column {
            id: wifiPage
            visible: qs.mode === "wifi"
            x: 6; y: 6
            width: parent.width - 12
            spacing: 1
            Title {
                text: "Wi-Fi"
                back: qs.from === "control"
                onBackClicked: qs.goBack()
                NexusSwitch {
                    id: wsw
                    visible: qs.wifiReady
                    width: 36; height: 21
                    anchors.verticalCenter: parent.verticalCenter
                    onToggled: qs.setWifi(checked)
                }
            }
            Binding { target: wsw; property: "checked"; value: qs.wifiReady && qs.wifi.on }
            Text {
                visible: text !== ""
                x: 10; width: parent.width - 20; wrapMode: Text.Wrap; bottomPadding: 8
                text: !qs.dev ? "Leyendo la red…"
                    : !qs.wifi.available ? "El Wi-Fi no está disponible: falta el gestor de red (NetworkManager)."
                    : !qs.wifi.hardware ? (qs.wifi.device ? "La tarjeta Wi-Fi está apagada con un interruptor o una tecla del equipo." : "Este equipo no tiene tarjeta Wi-Fi.")
                    : !qs.wifi.on ? "El Wi-Fi está apagado." : ""
                color: Theme.dim; font.family: Theme.font; font.pixelSize: 12
            }
            Column {
                visible: qs.wifiReady && qs.wifi.on
                width: parent.width
                spacing: 1
                NetRow {
                    visible: !!qs.curNet
                    net: qs.curNet || ({})
                    onDisconnect: qs.disconnectWifi()
                }
                Head { visible: qs.knownNets.length > 0; text: "Redes conocidas" }
                Repeater {
                    model: qs.knownNets
                    NetRow {
                        required property var modelData
                        net: modelData
                        connecting: qs.connecting === modelData.ssid
                        asking: qs.askFor === modelData.ssid
                        err: qs.errFor === modelData.ssid ? qs.errText : ""
                        onPicked: qs.pick(modelData)
                        onSubmit: (password) => qs.connectTo(modelData, password)
                        onCancel: { qs.askFor = ""; qs.errFor = ""; card.forceActiveFocus() }
                        onForget: qs.forget(modelData.ssid)
                    }
                }
                MenuItem {
                    label: "Otras redes"
                    hint: qs.scanning ? "Buscando…" : ""
                    chevron: true
                    open: qs.othersShown
                    onClicked: { qs.othersOpen = !qs.othersShown; if (qs.othersOpen) qs.refreshWifi(true) }
                }
                Repeater {
                    model: qs.othersShown ? qs.otherNets : []
                    NetRow {
                        required property var modelData
                        net: modelData
                        connecting: qs.connecting === modelData.ssid
                        asking: qs.askFor === modelData.ssid
                        err: qs.errFor === modelData.ssid ? qs.errText : ""
                        onPicked: qs.pick(modelData)
                        onSubmit: (password) => qs.connectTo(modelData, password)
                        onCancel: { qs.askFor = ""; qs.errFor = ""; card.forceActiveFocus() }
                    }
                }
                Text {
                    visible: qs.othersShown && qs.otherNets.length === 0
                    x: 42; bottomPadding: 4
                    text: qs.scanning || !qs.wl ? "Buscando redes…" : "No hay más redes cerca."
                    color: Theme.faint; font.family: Theme.font; font.pixelSize: 12
                }
            }
            Column {   // the cable (systemd-networkd looks after it; shown here as on a Mac)
                readonly property var eth: qs.wifi ? qs.wifi.ethernet : null
                visible: !!eth
                width: parent.width
                Sep {}
                Item {
                    width: parent.width; height: 40
                    Dot { x: 6; anchors.verticalCenter: parent.verticalCenter; on: !!parent.parent.eth && parent.parent.eth.connected; icon: "ethernet"; interactive: false }
                    Column {
                        x: 42; anchors.verticalCenter: parent.verticalCenter
                        Text { text: "Ethernet"; color: Theme.text; font.family: Theme.font; font.pixelSize: 13 }
                        Text {
                            readonly property var e: parent.parent.parent.eth
                            text: !e ? "" : e.connected ? "Conectado" + (e.address ? " · " + e.address : "") : "Sin cable"
                            color: Theme.dim; font.family: Theme.font; font.pixelSize: 11
                        }
                    }
                }
            }
            Sep {}
            Item { width: 1; height: 4 }
            MenuItem { label: "Ajustes de Wi-Fi…"; onClicked: { qs.close(); Session.openSettings("wifi") } }
        }

        // ================= Batería
        Column {
            id: batPage
            visible: qs.mode === "battery"
            x: 6; y: 6
            width: parent.width - 12
            spacing: 1
            Title {
                text: qs.bat ? "Batería" : "Energía"
                back: qs.from === "control"
                onBackClicked: qs.goBack()
                Text {
                    visible: !!qs.bat
                    anchors.verticalCenter: parent.verticalCenter
                    text: qs.bat ? qs.bat.percent + " %" : ""
                    color: Theme.dim; font.family: Theme.font; font.pixelSize: 13
                    font.features: { "tnum": 1 }
                }
            }
            Column {
                x: 10; width: parent.width - 20
                spacing: 3
                bottomPadding: 8
                Text {
                    width: parent.width; wrapMode: Text.Wrap
                    text: !qs.bat ? "Este equipo funciona enchufado a la corriente: no tiene batería."
                        : "Fuente de alimentación: " + (qs.bat.onAc || qs.bat.status === "Charging" || qs.bat.status === "Full" ? "adaptador de corriente" : "batería")
                    color: Theme.dim; font.family: Theme.font; font.pixelSize: 12
                }
                Text {
                    visible: !!qs.bat
                    text: qs.batTime(qs.bat)
                    color: Theme.text; font.family: Theme.font; font.pixelSize: 12
                }
                Text {
                    visible: !!qs.bat && qs.bat.healthPercent !== undefined && qs.bat.healthPercent !== null
                    width: parent.width; wrapMode: Text.Wrap
                    text: !(qs.bat && qs.bat.healthPercent != null) ? "" : "Estado: " + (qs.bat.healthPercent >= 80 ? "normal" : "conviene revisarla") + " · guarda el " + qs.bat.healthPercent
                        + " % de su capacidad" + (qs.bat.cycles ? " · " + qs.bat.cycles + " ciclos" : "")
                    color: qs.bat && qs.bat.healthPercent < 80 ? Theme.warn : Theme.dim; font.family: Theme.font; font.pixelSize: 12
                }
            }
            Column {
                visible: !!qs.pw
                width: parent.width
                spacing: 1
                Sep {}
                Head { text: "Modo de energía" }
                Repeater {
                    model: qs.pw ? ["power-saver", "balanced", "performance"].filter(function(m) { return qs.pw.modes.indexOf(m) >= 0 }) : []
                    MenuItem {
                        required property var modelData
                        label: qs.modeNames[modelData]
                        hint: modelData === "power-saver" ? (qs.bat ? "dura más" : "gasta menos") : modelData === "performance" ? "más rápido" : ""
                        checkable: true
                        checked: !!qs.pw && qs.pw.mode === modelData
                        onClicked: qs.setPowerMode(modelData)
                    }
                }
            }
            Item { width: 1; height: 4 }
            Sep {}
            Item { width: 1; height: 4 }
            MenuItem { label: qs.bat ? "Ajustes de la batería…" : "Ajustes de energía…"; onClicked: { qs.close(); Session.openSettings("bateria") } }
        }

        // ================= under the clock: the date, the weather, the notices
        Column {
            id: notPage
            visible: qs.mode === "notices"
            x: 14; y: 14
            width: parent.width - 28
            spacing: 10
            Column {
                width: parent.width
                Text {
                    text: qs.cap(Session.now.toLocaleDateString(Qt.locale("es_ES"), "dddd"))
                    color: Theme.accent; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold
                }
                Text {
                    text: Session.now.toLocaleDateString(Qt.locale("es_ES"), "d 'de' MMMM")
                    color: Theme.text; font.family: Theme.font; font.pixelSize: 26; font.weight: Font.Bold
                }
            }
            Tile {
                readonly property var w: Session.weather
                visible: !!w
                width: parent.width; height: 52
                Text {
                    x: 14; anchors.verticalCenter: parent.verticalCenter
                    text: parent.w ? Math.round(parent.w.temp) + "°" : ""
                    color: Theme.text; font.family: Theme.font; font.pixelSize: 24; font.weight: Font.Light
                }
                Column {
                    x: 74; anchors.verticalCenter: parent.verticalCenter
                    width: parent.width - 86
                    Text { width: parent.width; elide: Text.ElideRight; text: parent.parent.w ? qs.cap(parent.parent.w.text) + " · " + parent.parent.w.city : ""; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
                    Text {
                        readonly property var w: parent.parent.w
                        text: w && w.max !== undefined ? "Máx. " + Math.round(w.max) + "°   Mín. " + Math.round(w.min) + "°" : ""
                        color: Theme.dim; font.family: Theme.font; font.pixelSize: 11
                    }
                }
            }
            Item {
                width: parent.width; height: 20
                Text { anchors.verticalCenter: parent.verticalCenter; text: "Avisos"; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.Bold }
                Text {
                    visible: Session.recent.length > 0
                    anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                    text: "Borrar"; color: ca.containsMouse ? Theme.text : Theme.dim; font.family: Theme.font; font.pixelSize: 12
                    MouseArea { id: ca; anchors.fill: parent; anchors.margins: -6; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: Session.clearRecent() }
                }
            }
            Text {
                visible: Session.recent.length === 0
                text: Session.prefs.dnd === true ? "No molestar está activado: los avisos se guardan aquí." : "No hay avisos."
                color: Theme.faint; font.family: Theme.font; font.pixelSize: 12
            }
            Repeater {
                model: Session.recent.slice(0, 6)
                Tile {
                    required property var modelData
                    width: notPage.width; height: nt.height + 22
                    Rectangle { x: 12; y: 16; width: 7; height: 7; radius: 3.5; color: modelData.kind === "warn" ? Theme.warn : modelData.kind === "good" ? Theme.good : Theme.accent }
                    Text {
                        id: nt
                        x: 28; y: 11; width: parent.width - 28 - 66
                        text: modelData.text; wrapMode: Text.Wrap; maximumLineCount: 3; elide: Text.ElideRight
                        color: Theme.text; font.family: Theme.font; font.pixelSize: 12; lineHeight: 1.15
                    }
                    Text { anchors.right: parent.right; anchors.rightMargin: 12; y: 11; text: qs.ago(modelData.at); color: Theme.faint; font.family: Theme.font; font.pixelSize: 11 }
                }
            }
            Tile {
                width: parent.width; height: 46
                readonly property bool on: Session.prefs.dnd === true
                Dot { x: 10; anchors.verticalCenter: parent.verticalCenter; on: parent.on; icon: "moon"; interactive: false }
                Text { x: 46; anchors.verticalCenter: parent.verticalCenter; text: "No molestar"; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
                NexusSwitch {
                    id: dndSw
                    anchors.right: parent.right; anchors.rightMargin: 10; anchors.verticalCenter: parent.verticalCenter
                    width: 36; height: 21
                    onToggled: Session.setPref("dnd", checked)
                }
                Binding { target: dndSw; property: "checked"; value: Session.prefs.dnd === true }
            }
        }
    }
}
