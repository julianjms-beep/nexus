import QtQuick

// NEXUS shell: one process, several Wayland layer-shell surfaces.
// Start-up: the Intro (the boot splash's picture, same place) is made first and alone, so it is on screen ~0.2 s after
// the shell starts instead of ~1 s (making every surface first left that long black gap after the boot splash). The
// desktop's surfaces are then made one per tick underneath it, so its dots keep moving, and only when all of them exist
// does the Intro open up into the desktop.
QtObject {
    id: root
    property var intro: Intro { onShown: root.build() }
    property var wallpaper: null
    property var topBar: null
    property var dock: null
    property var toasts: null
    property var ai: null
    property var power: null
    property var confirm: null
    property var quick: null
    property var taskbar: null
    property var start: null
    property var menuBar: null

    // Both desktops are made; Session.layout shows one: "barra" (the Mac-like menu bar on top, the taskbar and start
    // menu at the bottom; the default since 09-11) or "clasico" (top bar + dock). Switching in Ajustes is instant.
    readonly property var names: ["wallpaper", "topBar", "dock", "toasts", "ai", "power", "confirm", "quick", "taskbar", "start", "menuBar"]
    property list<Component> parts: [
        Component { Wallpaper {} }, Component { TopBar {} }, Component { Dock {} }, Component { Toasts {} },
        Component { AiPanel {} }, Component { PowerMenu {} }, Component { ConfirmDialog {} }, Component { QuickSettings {} },
        Component { Taskbar {} }, Component { StartMenu {} }, Component { MenuBar {} }
    ]
    property int made: 0
    function build() { if (made === 0 && !maker.running) maker.start() }
    property Timer maker: Timer {
        interval: 16; repeat: true
        onTriggered: {
            if (root.made < root.parts.length) {
                var o = root.parts[root.made].createObject(root)
                if (!o) console.warn("nexus-shell: could not create " + root.names[root.made] + ": " + root.parts[root.made].errorString())
                root[root.names[root.made]] = o
                root.made++
            }
            if (root.made >= root.parts.length) {
                stop(); root.intro.open()
                // tell nexus-sessiond which parts are on screen: NEXUS Update only keeps an update whose desktop came
                // back whole (a part that does not load leaves the shell running without it, which systemd cannot see)
                var failed = root.names.filter(function(n) { return !root[n] })
                Session.reportShell(root.names, failed)
            }
        }
    }
    // no frame report from the compositor: build anyway
    property Timer fallback: Timer { interval: 600; running: true; onTriggered: root.build() }

    // the wallpaper hides its clock while a full-screen panel or dialog is open
    property Binding overlay: Binding { target: Session; property: "overlay"; value: (!!root.ai && root.ai.shown) || (!!root.confirm && root.confirm.shown) }

    property Connections bus: Connections {
        target: Session
        function onUiRequested(panel, text) {
            if (!root.ai || !root.power) return
            var qsMode = ({ quick: "control", wifi: "wifi", battery: "battery", notices: "notices" })[panel] || ""
            if (root.quick && !qsMode) root.quick.close()   // one panel at a time (its own menus switch in place)
            if (root.start && panel !== "start") root.start.close()
            if (root.menuBar) root.menuBar.closeMenu()
            if (panel === "start" && root.start) { root.ai.close(); root.power.close(); root.start.toggle() }
            else if (panel === "ai" && text) { root.power.close(); root.ai.openAndAsk(text) }
            else if (panel === "ai" || panel === "launcher") { root.power.close(); root.ai.toggle() }
            else if (panel === "power") { root.ai.close(); root.power.toggle() }
            else if (qsMode && root.quick) { root.ai.close(); root.power.close(); root.quick.toggleMode(qsMode, Session.panelLeft, Session.panelRight) }
        }
        function onConfirmRequested(cid, action, reason, origin) {
            if (!root.confirm) return
            if (root.ai) root.ai.close()
            if (root.power) root.power.close()
            if (root.quick) root.quick.close()
            if (root.start) root.start.close()
            if (root.menuBar) root.menuBar.closeMenu()
            root.confirm.ask(cid, action, reason, origin)
        }
        function onToast(text, kind) { if (root.toasts) root.toasts.show(text, kind) }
        function onPrefillRequested(text) { if (!root.ai) return; if (root.power) root.power.close(); if (root.start) root.start.close(); root.ai.openWith(text) }
    }
}
