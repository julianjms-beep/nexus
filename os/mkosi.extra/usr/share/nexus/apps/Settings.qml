import QtQuick
import QtQuick.Window
import QtQuick.Controls
import QtCore
import Qt.labs.folderlistmodel
import "../shell"

// Ajustes: appearance, wallpaper, NEXUS AI key, about this computer. `--page=fondo` opens it at that page.
Window {
    id: w
    visible: true
    width: 920; height: 620
    minimumWidth: 720; minimumHeight: 480
    title: "Ajustes"
    color: Theme.bg

    property string section: "apariencia"
    // id, name, icon and the colour of its tile in the sidebar
    readonly property var sections: [["apariencia", "Apariencia", "palette", "#7c6cff"], ["fondo", "Fondo", "image", "#2f9bff"], ["ai", "NEXUS AI", "sparkle", "#b45cff"], ["wifi", "Wi-Fi", "globe", "#2f9bff"], ["bluetooth", "Bluetooth", "bluetooth", "#2f6bff"], ["bateria", "Batería", "plug", "#22b573"], ["sonido", "Sonido", "speaker", "#ff5c7a"], ["pantalla", "Pantalla", "sun", "#5b8def"], ["teclado", "Teclado e idioma", "list", "#8b8f9a"], ["buscador", "Buscador", "search", "#0ea5c4"], ["terminal", "Terminal", "terminal", "#1f2333"],
                                     ["seguridad", "Privacidad y seguridad", "shield", "#22b573"], ["actualizaciones", "Actualizaciones", "update", "#ff8f2e"], ["acerca", "Acerca de", "info", "#7d859f"]]
    // how many things Privacidad y seguridad would improve (the red badge in the sidebar)
    property int secTodo: 0
    function loadSecurity() {
        Session.request("GET", "/security", null, function(st, j) {
            if (st !== 200 || !j || !j.items) return
            var n = 0; for (var i = 0; i < j.items.length; i++) if (j.items[i].level === "bad" || j.items[i].level === "warn") n++
            w.secTodo = n
        })
    }
    Component.onCompleted: {
        var a = Qt.application.arguments
        for (var i = 0; i < a.length; i++) {
            var v = String(a[i])
            if (v.indexOf("--page=") === 0) { if (v.slice(7) === "cuenta") section = "cuenta"; for (var k = 0; k < sections.length; k++) if (sections[k][0] === v.slice(7)) section = v.slice(7) }
        }
        loadGallery()
        loadSecurity()
        Session.wantUpdate = true
        Session.refreshUpdate()
    }
    Connections {   // the desktop's "Cambiar el fondo…" while Ajustes is already open
        target: Session
        function onUiRequested(panel, text) { if (panel === "settings") { if (text === "cuenta") w.section = "cuenta"; for (var k = 0; k < w.sections.length; k++) if (w.sections[k][0] === text) w.section = text } }
        function onWallpaperChanged() { w.loadGallery() }
        function onSecurityChanged() { w.loadSecurity() }
        // a mode picked here (Imagen, Tu foto) waits for its first choice; once nexus-sessiond has it, the prefs say
        // the same. Never cleared inside a thumbnail's click: that hides the grid and destroys the thumbnail mid-click.
        function onPrefsChanged() { if (w.modeOverride && w.modeOf(Session.prefs) === w.modeOverride) w.modeOverride = "" }
    }
    Connections { target: Theme; function onDarkChanged() { w.loadGallery() } }
    onSectionChanged: modeOverride = ""

    // ---- wallpaper (Fondo): the collection comes from nexus-sessiond (GET /wallpapers), what is on screen from Session
    property var gallery: null
    readonly property var cur: Session.wallpaper
    property string modeOverride: ""   // a mode chosen here that needs a pick first (Imagen, Tu foto)
    readonly property string mode: modeOverride || modeOf(Session.prefs)
    // ~/Imágenes (from ~/.config/user-dirs.dirs); without that file Qt answers the home folder itself, so fall back
    readonly property string picturesPath: {
        var strip = function(u) { return decodeURIComponent(String(u).replace(/^file:\/\//, "")) }
        var home = strip(StandardPaths.writableLocation(StandardPaths.HomeLocation))
        var p = strip(StandardPaths.writableLocation(StandardPaths.PicturesLocation))
        return p && p !== home ? p : home + "/Imágenes"
    }
    // Tu foto: the folder being browsed (Imágenes or one of its folders); starts where the current picture is
    property string photoDir: ""
    readonly property string photoDirShown: photoDir || (cur && cur.id === "custom" && cur.file ? String(cur.file).replace(/\/[^\/]*$/, "") : picturesPath)
    function loadGallery() { Session.request("GET", "/wallpapers", null, function(st, j) { if (st === 200 && j) w.gallery = j }) }
    function fileUrl(p) { return p ? "file://" + String(p).split("/").map(encodeURIComponent).join("/") : "" }
    function modeOf(p) {
        var v = String(p.wallpaper || "")
        if (v === "slideshow") return "presentacion"
        if (v === "color") return "color"
        if (v === "accent") return "acento"
        if (v === "custom") return "foto"
        var g = gallery ? gallery.collection : []
        for (var i = 0; i < g.length; i++) if (g[i].id === v && g[i].dynamic) return "hora"
        return "imagen"
    }
    function pickMode(m) {
        modeOverride = m
        if (m === "hora") { var g = gallery ? gallery.collection : []; for (var i = 0; i < g.length; i++) if (g[i].dynamic) { Session.setPref("wallpaper", g[i].id); break } }
        else if (m === "presentacion") Session.setPref("wallpaper", "slideshow")
        else if (m === "color") Session.setPrefs({ wallpaper: "color", wallpaperColor: Session.prefs.wallpaperColor || "#1f3b4d" })
        else if (m === "acento") Session.setPref("wallpaper", "accent")
    }
    // ---- Actualizaciones (NEXUS Update: nexus-updated through nexus-sessiond)
    readonly property var up: Session.update
    readonly property string upState: !up ? "loading" : up.unavailable ? "unavailable" : (up.state === "idle" && up.checkFailed) ? "checkfail" : String(up.state || "idle")
    readonly property string upVersion: up && up.available ? String(up.available.version) : ""
    function fmtWhen(iso) {
        if (!iso) return ""
        var d = new Date(iso), t = new Date()
        var y = new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1)
        var day = d.toDateString() === t.toDateString() ? "hoy" : d.toDateString() === y.toDateString() ? "ayer" : d.toLocaleDateString(Qt.locale("es_ES"), "d 'de' MMMM")
        return day + " a las " + d.toLocaleTimeString(Qt.locale("es_ES"), "HH:mm")
    }
    function fmtSize(b) { return !b ? "" : b >= 1e6 ? (b / 1e6).toFixed(1).replace(".", ",") + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB" }
    property string keyMsg: ""
    property bool keyErr: false
    readonly property var sys: Session.system
    readonly property var accents: ["#7c6cff", "#38d9ff", "#3ddc97", "#ffb84d", "#ff5c7a", "#5c9dff"]
    function fmtBytes(b) { return b ? (b / 1073741824).toFixed(1).replace(".", ",") + " GB" : "–" }

    Timer { interval: 3000; running: true; repeat: true; triggeredOnStart: true; onTriggered: Session.refreshSystem() }

    Rectangle {
        id: side
        width: 270; height: parent.height
        color: Theme.card
        Rectangle { anchors.right: parent.right; width: 1; height: parent.height; color: Theme.border }
        // the selection is one pill that glides to the chosen section (with an accent bar, as in Windows 11)
        Rectangle {
            id: navPill
            readonly property Item at: { var n = navRep.count; for (var i = 0; i < n; i++) if (w.sections[i][0] === w.section) return navRep.itemAt(i); return null }
            visible: at !== null
            x: navCol.x; width: navCol.width; height: 38; radius: 10
            y: at ? navCol.y + at.y : 0
            color: Theme.alpha(Theme.accent, 0.18)
            Behavior on y { NumberAnimation { duration: Theme.ms(240); easing.type: Easing.OutCubic } }
            Rectangle {
                x: 2; anchors.verticalCenter: parent.verticalCenter; width: 3; radius: 1.5; color: Theme.accent
                height: 16
                // it stretches a little while it travels, then settles
                SequentialAnimation on height {
                    id: barStretch; running: false
                    NumberAnimation { to: 26; duration: Theme.ms(110); easing.type: Easing.OutQuad }
                    NumberAnimation { to: 16; duration: Theme.ms(200); easing.type: Easing.OutCubic }
                }
            }
            onYChanged: if (!barStretch.running && Theme.motion) barStretch.start()
        }
        Column {
            id: navCol
            x: 12; y: 18; width: parent.width - 24
            spacing: 4
            Text { x: 10; text: "Ajustes"; color: Theme.text; font.family: Theme.font; font.pixelSize: 20; font.weight: Font.DemiBold; bottomPadding: 8 }
            // the person of this computer (their password lives in Privacidad y seguridad)
            Rectangle {
                width: parent.width; height: 58; radius: 14
                color: meArea.containsMouse ? Theme.hover : Theme.alpha(Theme.text, 0.04)
                Behavior on color { ColorAnimation { duration: Theme.ms(140) } }
                Rectangle {
                    x: 10; anchors.verticalCenter: parent.verticalCenter; width: 38; height: 38; radius: 19
                    gradient: Gradient { GradientStop { position: 0; color: Theme.accent } GradientStop { position: 1; color: Theme.accent2 } }
                    Text { anchors.centerIn: parent; visible: !Session.me.photo; text: (Session.me.name || "?").charAt(0).toUpperCase(); color: "#ffffff"; font.family: Theme.font; font.pixelSize: 17; font.weight: Font.DemiBold }
                    Avatar { anchors.fill: parent; photo: Session.me.photo; stamp: Session.meStamp }
                }
                Column {
                    x: 58; width: parent.width - 66; anchors.verticalCenter: parent.verticalCenter
                    Text { width: parent.width; elide: Text.ElideRight; text: Session.me.name || "Tu cuenta"; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.DemiBold }
                    Text { width: parent.width; elide: Text.ElideRight; text: "Cuenta y contraseña"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                }
                MouseArea { id: meArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: w.section = "cuenta" }
            }
            Item { width: 1; height: 6 }
            Repeater {
                id: navRep
                model: w.sections
                Rectangle {
                    required property var modelData
                    readonly property bool on: w.section === modelData[0]
                    width: parent.width; height: 38; radius: 10
                    color: !on && sa.containsMouse ? Theme.hover : "transparent"
                    Behavior on color { ColorAnimation { duration: Theme.ms(140) } }
                    // a coloured tile with the section's icon, as in macOS's settings
                    Rectangle {
                        x: 10; anchors.verticalCenter: parent.verticalCenter; width: 26; height: 26; radius: 8
                        gradient: Gradient { GradientStop { position: 0; color: Qt.lighter(modelData[3], 1.18) } GradientStop { position: 1; color: modelData[3] } }
                        LineIcon { anchors.centerIn: parent; name: modelData[2]; color: "#ffffff"; size: 16; stroke: 1.9 }
                    }
                    Text { x: 46; width: parent.width - 46 - (badge.visible ? 34 : 8); elide: Text.ElideRight; anchors.verticalCenter: parent.verticalCenter; text: modelData[1]; color: on ? Theme.text : Theme.dim; font.family: Theme.font; font.pixelSize: 14; font.weight: on ? Font.DemiBold : Font.Normal }
                    Rectangle {
                        id: badge
                        visible: modelData[0] === "seguridad" && w.secTodo > 0
                        anchors.right: parent.right; anchors.rightMargin: 8; anchors.verticalCenter: parent.verticalCenter
                        width: Math.max(20, badgeText.implicitWidth + 10); height: 20; radius: 10; color: Theme.danger
                        Text { id: badgeText; anchors.centerIn: parent; text: w.secTodo; color: "#ffffff"; font.family: Theme.font; font.pixelSize: 11; font.weight: Font.Bold }
                    }
                    MouseArea { id: sa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: w.section = modelData[0] }
                }
            }
        }
    }

    Item {
        id: pages
        anchors.left: side.right; anchors.right: parent.right; anchors.top: parent.top; anchors.bottom: parent.bottom
        anchors.margins: 28
        // a new section comes in with a short fade and a small drop (the old one is simply gone: no waiting)
        transform: Translate { id: pagesShift }
        Connections { target: w; function onSectionChanged() { pageIn.restart() } }
        ParallelAnimation {
            id: pageIn
            NumberAnimation { target: pages; property: "opacity"; from: 0; to: 1; duration: Theme.ms(180); easing.type: Easing.OutCubic }
            NumberAnimation { target: pagesShift; property: "y"; from: 10; to: 0; duration: Theme.ms(240); easing.type: Easing.OutCubic }
        }

        // ---------------- the computer's parts and the person (apps/*Page.qml)
        WifiPage { visible: w.section === "wifi"; anchors.fill: parent }
        BluetoothPage { visible: w.section === "bluetooth"; anchors.fill: parent }
        BatteryPage { visible: w.section === "bateria"; anchors.fill: parent }
        SoundPage { visible: w.section === "sonido"; anchors.fill: parent }
        DisplayPage { visible: w.section === "pantalla"; anchors.fill: parent }
        KeyboardPage { visible: w.section === "teclado"; anchors.fill: parent }
        AccountPage { visible: w.section === "cuenta"; anchors.fill: parent; onOpenPage: function(section) { w.section = section } }

        // ---------------- Buscador (apps/SearchPage.qml)
        SearchPage { visible: w.section === "buscador"; anchors.fill: parent }

        // ---------------- Terminal (apps/TerminalPage.qml)
        TerminalPage { visible: w.section === "terminal"; anchors.fill: parent }

        // ---------------- Privacidad y seguridad (apps/SecurityPage.qml)
        SecurityPage {
            visible: w.section === "seguridad"
            anchors.fill: parent
            onOpenPage: function(section) { w.section = section }
        }

        // ---------------- Apariencia
        Flickable {
            id: apPage
            visible: w.section === "apariencia"
            anchors.fill: parent
            contentWidth: width; contentHeight: apCol.height + 24
            clip: true; boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
        Column {
            id: apCol
            width: apPage.width - 14
            spacing: 18
            Text { text: "Apariencia"; color: Theme.text; font.family: Theme.font; font.pixelSize: 24; font.weight: Font.DemiBold }
            // (a Flow, so in a narrow window — half the screen — the wallpaper card goes below instead of off the edge;
            //  the spacing leaves room for the names under the cards)
            Flow {
                width: parent.width
                spacing: 34
                Column {
                    spacing: 10
                    Text { text: "Tema"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                    Row {
                        spacing: 12
                        Repeater {
                            model: [["dark", "Oscuro", "#0b0e17", "#1b2033"], ["light", "Claro", "#eef1f8", "#ffffff"]]
                            Rectangle {
                                required property var modelData
                                readonly property bool on: (modelData[0] === "dark") === Theme.dark
                                width: 146; height: 96; radius: 16
                                color: modelData[2]
                                border.color: on ? Theme.accent : Theme.border; border.width: on ? 3 : 1
                                Rectangle { x: 12; y: 12; width: parent.width - 24; height: 10; radius: 4; color: modelData[3] }
                                Rectangle { x: 12; y: 30; width: 56; height: 42; radius: 8; color: modelData[3] }
                                Rectangle { x: 76; y: 30; width: 58; height: 18; radius: 6; color: Theme.accent }
                                Text { anchors.horizontalCenter: parent.horizontalCenter; anchors.bottom: parent.bottom; anchors.bottomMargin: -24; text: modelData[1]; color: Theme.text; font.family: Theme.font; font.pixelSize: 13 }
                                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: Session.setPref("theme", modelData[0]) }
                            }
                        }
                    }
                }
                // the desktop's look: "barra" (one bar at the bottom with the start menu, the default) or "clasico"
                // (the top bar and the dock). The desktop changes at once; nothing restarts.
                Column {
                    spacing: 10
                    Text { text: "Escritorio"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                    Row {
                        spacing: 12
                        Repeater {
                            model: [["barra", "Barra"], ["clasico", "Clásico"]]
                            Rectangle {
                                id: lay
                                required property var modelData
                                readonly property bool on: (Session.prefs.layout === "clasico" ? "clasico" : "barra") === modelData[0]
                                readonly property color ink: Theme.dark ? "#e9ecf5" : "#1a1f2e"
                                width: 146; height: 96; radius: 16
                                color: Theme.dark ? "#0b0e17" : "#eef1f8"
                                border.color: on ? Theme.accent : Theme.border; border.width: on ? 3 : 1
                                // Barra: one dark bar along the bottom, a round start button, icons in the middle
                                Item {
                                    visible: lay.modelData[0] === "barra"
                                    anchors.fill: parent
                                    Rectangle { x: 3; y: parent.height - 21; width: parent.width - 6; height: 18; radius: 2; color: Theme.dark ? "#1b2033" : "#ffffff"
                                        Rectangle { x: 6; anchors.verticalCenter: parent.verticalCenter; width: 10; height: 10; radius: 5; color: "#22d3ee" }
                                        Row { anchors.centerIn: parent; spacing: 5
                                            Repeater { model: 5; Rectangle { width: 7; height: 7; radius: 2; color: lay.ink; opacity: 0.8 } } }
                                        Rectangle { anchors.right: parent.right; anchors.rightMargin: 6; anchors.verticalCenter: parent.verticalCenter; width: 22; height: 4; radius: 2; color: lay.ink; opacity: 0.6 }
                                    }
                                }
                                // Clásico: the floating top bar and the dock
                                Item {
                                    visible: lay.modelData[0] === "clasico"
                                    anchors.fill: parent
                                    Rectangle { x: 8; y: 8; width: parent.width - 16; height: 9; radius: 4; color: Theme.dark ? "#1b2033" : "#ffffff" }
                                    Rectangle { anchors.horizontalCenter: parent.horizontalCenter; y: parent.height - 24; width: 74; height: 16; radius: 6; color: Theme.dark ? "#1b2033" : "#ffffff"
                                        Row { anchors.centerIn: parent; spacing: 4
                                            Repeater { model: 5; Rectangle { width: 9; height: 9; radius: 3; color: Theme.accent; opacity: 0.85 } } }
                                    }
                                }
                                Text { anchors.horizontalCenter: parent.horizontalCenter; anchors.bottom: parent.bottom; anchors.bottomMargin: -24; text: lay.modelData[1]; color: Theme.text; font.family: Theme.font; font.pixelSize: 13 }
                                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: Session.setPref("layout", lay.modelData[0]) }
                            }
                        }
                    }
                }
                // the wallpaper has its own page: a small card that leads there
                Rectangle {
                    width: 210; height: 96; radius: 16
                    color: Theme.card2   // no clip: the name hangs below the card (the picture crops itself)
                    border.color: fl.containsMouse ? Theme.accent : Theme.border
                    Image {
                        anchors.fill: parent; anchors.margins: 1
                        visible: !!(w.cur && w.cur.kind === "image")
                        source: w.cur && w.cur.kind === "image" ? w.fileUrl(w.cur.file) : ""
                        sourceSize: Qt.size(420, 262); fillMode: Image.PreserveAspectCrop; asynchronous: true
                    }
                    Rectangle { anchors.fill: parent; anchors.margins: 1; radius: 15; visible: !!(w.cur && w.cur.kind === "color"); color: w.cur && w.cur.color ? w.cur.color : "transparent" }
                    Rectangle { anchors.fill: parent; color: "transparent"; radius: 16; border.color: Theme.bg; border.width: 2 }
                    Text { anchors.horizontalCenter: parent.horizontalCenter; anchors.bottom: parent.bottom; anchors.bottomMargin: -24; text: "Fondo · cambiar"; color: fl.containsMouse ? Theme.accent : Theme.text; font.family: Theme.font; font.pixelSize: 13 }
                    MouseArea { id: fl; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: w.section = "fondo" }
                }
            }
            Item { width: 1; height: 16 }
            Text { text: "Color de acento"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
            Row {
                spacing: 12
                Repeater {
                    model: w.accents
                    Rectangle {
                        required property string modelData
                        width: 36; height: 36; radius: 18
                        color: modelData
                        border.color: Theme.text; border.width: String(Theme.accent) === modelData ? 3 : 0
                        MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: Session.setPref("accent", modelData) }
                    }
                }
            }
            Item { width: 1; height: 8 }
            Row {
                spacing: 12
                NexusSwitch { id: c24; anchors.verticalCenter: parent.verticalCenter; checked: Session.clock24; onToggled: Session.setPref("clock24", checked) }
                Text { anchors.verticalCenter: parent.verticalCenter; text: "Reloj de 24 horas"; color: Theme.text; font.family: Theme.font; font.pixelSize: 14 }
            }
            Row {
                spacing: 12
                NexusSwitch { anchors.verticalCenter: parent.verticalCenter; checked: Session.prefs.animations !== false; onToggled: Session.setPref("animations", checked) }
                Column {
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 2
                    Text { text: "Animaciones"; color: Theme.text; font.family: Theme.font; font.pixelSize: 14 }
                    Text { width: apCol.width - 64; wrapMode: Text.Wrap; text: "Las ventanas se abren, se cierran y van al dock con suavidad. Apágalas si prefieres que todo sea instantáneo."; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                }
            }
            Item { width: 1; height: 16 }
            Text { text: "Tamaño de la interfaz"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
            Flow {
                width: parent.width
                spacing: 8
                Repeater {
                    model: [["auto", "Automático"], [1, "100 %"], [1.25, "125 %"], [1.5, "150 %"], [2, "200 %"]]
                    Rectangle {
                        required property var modelData
                        readonly property bool on: String(Session.prefs.scale === undefined ? "auto" : Session.prefs.scale) === String(modelData[0])
                        width: sz.implicitWidth + 26; height: 32; radius: 16
                        color: on ? Theme.alpha(Theme.accent, 0.22) : Theme.card2
                        border.color: on ? Theme.accent : Theme.border
                        Text { id: sz; anchors.centerIn: parent; text: modelData[1]; color: on ? Theme.text : Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                        MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: Session.setPref("scale", modelData[0]) }
                    }
                }
            }
            Text { width: parent.width; wrapMode: Text.Wrap; text: "Automático elige según la pantalla. Todo se ve más grande o más pequeño al momento."; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12 }
            Item { width: 1; height: 16 }
            Text { text: "El tiempo en el escritorio"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
            Flow {
                width: Math.min(560, parent.width)
                spacing: 8
                Repeater {
                    model: [["madrid", "Madrid"], ["barcelona", "Barcelona"], ["valencia", "Valencia"], ["sevilla", "Sevilla"], ["zaragoza", "Zaragoza"],
                            ["murcia", "Murcia"], ["malaga", "Málaga"], ["bilbao", "Bilbao"], ["off", "No mostrar"]]
                    Rectangle {
                        required property var modelData
                        readonly property bool on: String(Session.prefs.city || "madrid") === modelData[0]
                        width: chip.implicitWidth + 26; height: 32; radius: 16
                        color: on ? Theme.alpha(Theme.accent, 0.22) : Theme.card2
                        border.color: on ? Theme.accent : Theme.border
                        Text { id: chip; anchors.centerIn: parent; text: modelData[1]; color: on ? Theme.text : Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                        MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: Session.setPref("city", modelData[0]) }
                    }
                }
            }
            Text { text: "Datos de Open-Meteo. Solo se envían las coordenadas de la ciudad."; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12 }
        }
        }

        // ---------------- Fondo
        Flickable {
            id: fondoPage
            visible: w.section === "fondo"
            anchors.fill: parent
            contentWidth: width; contentHeight: fondoCol.height + 24
            clip: true; boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
            Column {
                id: fondoCol
                width: fondoPage.width - 14
                spacing: 14
                Text { text: "Fondo"; color: Theme.text; font.family: Theme.font; font.pixelSize: 24; font.weight: Font.DemiBold }
                // the desktop in miniature (the picture, the clock in the colour it will have, the bar and the dock) and,
                // beside it, what it is and "Siguiente" — so the choices below fit without scrolling
                Row {
                spacing: 20
                Rectangle {
                    id: preview
                    width: Math.min(fondoCol.width * 0.48, 320); height: Math.round(width * 10 / 16); radius: 16
                    color: Theme.card2; clip: true
                    readonly property bool lightInk: !w.cur || w.cur.ink !== "dark"
                    Image {
                        anchors.fill: parent
                        visible: !!(w.cur && w.cur.kind === "image")
                        source: w.cur && w.cur.kind === "image" ? w.fileUrl(w.cur.file) : ""
                        sourceSize: Qt.size(880, 550)
                        fillMode: w.cur && w.cur.fit === "fit" ? Image.PreserveAspectFit : w.cur && w.cur.fit === "center" ? Image.Pad : Image.PreserveAspectCrop
                        asynchronous: true
                    }
                    Rectangle { anchors.fill: parent; visible: !!(w.cur && w.cur.kind === "color"); color: w.cur && w.cur.color ? w.cur.color : "transparent" }
                    Rectangle {
                        anchors.fill: parent; visible: !!(w.cur && w.cur.kind === "accent")
                        gradient: Gradient {
                            orientation: Gradient.Horizontal
                            GradientStop { position: 0; color: Theme.alpha(Theme.accent, Theme.dark ? 0.55 : 0.35) }
                            GradientStop { position: 0.6; color: Theme.bg }
                            GradientStop { position: 1; color: Theme.dark ? "#1b2440" : "#dff3fb" }
                        }
                    }
                    Rectangle { width: parent.width; height: 14; color: Theme.panel }
                    Text {
                        anchors.centerIn: parent; anchors.verticalCenterOffset: -14
                        text: Qt.formatTime(Session.now, Session.clock24 ? "HH:mm" : "h:mm")
                        color: preview.lightInk ? "#ffffff" : "#151a2b"
                        font.family: "Inter Display"; font.pixelSize: Math.round(preview.height * 0.22); font.weight: Font.ExtraLight
                    }
                    Rectangle { anchors.horizontalCenter: parent.horizontalCenter; anchors.bottom: parent.bottom; anchors.bottomMargin: 10; width: parent.width * 0.42; height: 20; radius: 10; color: Theme.panel; border.color: Theme.border }
                    Rectangle { anchors.fill: parent; color: "transparent"; radius: 16; border.color: Theme.border }
                }
                Column {
                    anchors.verticalCenter: preview.verticalCenter
                    width: fondoCol.width - preview.width - 20
                    spacing: 6
                    Text { text: "En tu escritorio"; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12 }
                    Text {
                        width: parent.width; elide: Text.ElideRight
                        text: !w.cur ? "" : w.cur.kind === "color" ? "Color sólido" : w.cur.kind === "accent" ? "Manchas del color de acento" : (w.cur.name || "")
                        color: Theme.text; font.family: Theme.font; font.pixelSize: 18; font.weight: Font.DemiBold
                    }
                    Text {
                        width: parent.width; wrapMode: Text.Wrap
                        text: {
                            var m = w.modeOf(Session.prefs)
                            if (m === "presentacion") { var e = Session.prefs.slideshowEvery || 30; return "Presentación: cambia cada " + (e === 1440 ? "día" : e === 60 ? "hora" : e === 1 ? "minuto" : e + " minutos") }
                            if (m === "hora") return "Cambia con la hora del día"
                            if (m === "foto") return "Tu foto · " + ({ fill: "rellenar", fit: "ajustar", center: "centrar" })[Session.prefs.wallpaperFit || "fill"]
                            if (m === "imagen") return "Colección NEXUS · sigue al tema claro u oscuro"
                            return ""
                        }
                        color: Theme.dim; font.family: Theme.font; font.pixelSize: 13
                    }
                    Item { width: 1; height: 4 }
                    Rectangle {
                        visible: !!(w.cur && w.cur.id === "slideshow")
                        width: nx.implicitWidth + 26; height: 32; radius: 16
                        color: nxa.containsMouse ? Theme.hover : Theme.card2; border.color: Theme.border
                        Behavior on color { ColorAnimation { duration: Theme.ms(140) } }
                        Text { id: nx; anchors.centerIn: parent; text: "Siguiente imagen  →"; color: Theme.text; font.family: Theme.font; font.pixelSize: 13 }
                        MouseArea { id: nxa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: Session.nextWallpaper() }
                    }
                }
                }
                Item { width: 1; height: 2 }
                Text { text: "Personaliza el fondo"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                Flow {
                    width: parent.width
                    spacing: 8
                    Repeater {
                        model: [["imagen", "Imagen"], ["hora", "Según la hora"], ["presentacion", "Presentación"], ["color", "Color sólido"], ["acento", "Acento"], ["foto", "Tu foto"]]
                        Rectangle {
                            required property var modelData
                            readonly property bool on: w.mode === modelData[0]
                            width: mc.implicitWidth + 28; height: 34; radius: 17
                            color: on ? Theme.alpha(Theme.accent, 0.22) : mca.containsMouse ? Theme.hover : Theme.card2
                            border.color: on ? Theme.accent : Theme.border
                            Behavior on color { ColorAnimation { duration: Theme.ms(140) } }
                            Text { id: mc; anchors.centerIn: parent; text: modelData[1]; color: on ? Theme.text : Theme.dim; font.family: Theme.font; font.pixelSize: 13; font.weight: on ? Font.DemiBold : Font.Normal }
                            MouseArea { id: mca; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: w.pickMode(modelData[0]) }
                        }
                    }
                }

                // Imagen / Según la hora: NEXUS's collection (thumbnails for the current theme)
                Flow {
                    visible: w.mode === "imagen" || w.mode === "hora"
                    width: parent.width
                    spacing: 14
                    Repeater {
                        model: w.gallery ? w.gallery.collection.filter(function(c) { return (w.mode === "hora") === !!c.dynamic }) : []
                        Column {
                            required property var modelData
                            readonly property bool on: String(Session.prefs.wallpaper || "") === modelData.id || (!Session.prefs.wallpaper && w.cur && w.cur.id === modelData.id)
                            spacing: 6
                            Rectangle {
                                width: 186; height: 116; radius: 14
                                color: Theme.card2
                                border.color: on ? Theme.accent : ta.containsMouse ? Theme.dim : Theme.border; border.width: on ? 3 : 1
                                Image {
                                    anchors.fill: parent; anchors.margins: on ? 5 : 3
                                    source: w.fileUrl(modelData.thumb)
                                    sourceSize: Qt.size(360, 225); fillMode: Image.PreserveAspectCrop; asynchronous: true
                                    opacity: status === Image.Ready ? 1 : 0
                                    Behavior on opacity { NumberAnimation { duration: Theme.ms(220) } }
                                }
                                // rounds the picture's corners (no shader needed, also with software rendering)
                                Rectangle { anchors.fill: parent; anchors.margins: on ? 3 : 1; color: "transparent"; radius: 12; border.color: Theme.bg; border.width: 3 }
                                Rectangle {
                                    visible: modelData.dynamic
                                    anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 10
                                    width: dl.implicitWidth + 14; height: 22; radius: 11; color: Qt.rgba(0, 0, 0, 0.45)
                                    Text { id: dl; anchors.centerIn: parent; text: "cambia con la hora"; color: "#ffffff"; font.family: Theme.font; font.pixelSize: 11 }
                                }
                                MouseArea { id: ta; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: Session.setPref("wallpaper", modelData.id) }
                            }
                            Text { text: modelData.name; color: on ? Theme.text : Theme.dim; font.family: Theme.font; font.pixelSize: 13; font.weight: on ? Font.DemiBold : Font.Normal }
                        }
                    }
                }
                Text {
                    visible: w.mode === "hora"
                    width: parent.width; wrapMode: Text.Wrap
                    text: "Amanece a las 6:00, es de día a las 9:00, atardece a las 18:00 y se hace de noche a las 21:00. El cambio es suave."
                    color: Theme.faint; font.family: Theme.font; font.pixelSize: 12
                }

                // Presentación: every N minutes, NEXUS's pictures or a folder of the person's
                Column {
                    visible: w.mode === "presentacion"
                    width: parent.width
                    spacing: 10
                    Text { text: "Cambiar la imagen cada"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                    Flow {
                        width: parent.width; spacing: 8
                        Repeater {
                            model: [[1, "1 minuto"], [5, "5 minutos"], [10, "10 minutos"], [30, "30 minutos"], [60, "1 hora"], [1440, "1 día"]]
                            Rectangle {
                                required property var modelData
                                readonly property bool on: (Session.prefs.slideshowEvery || 30) === modelData[0]
                                width: ev.implicitWidth + 26; height: 32; radius: 16
                                color: on ? Theme.alpha(Theme.accent, 0.22) : Theme.card2; border.color: on ? Theme.accent : Theme.border
                                Text { id: ev; anchors.centerIn: parent; text: modelData[1]; color: on ? Theme.text : Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: Session.setPref("slideshowEvery", modelData[0]) }
                            }
                        }
                    }
                    Text { text: "Imágenes de"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                    Flow {
                        width: parent.width; spacing: 8
                        Repeater {
                            model: [["", "Colección NEXUS"], [w.picturesPath, "Imágenes"]].concat(subFolders.list)
                            Rectangle {
                                required property var modelData
                                readonly property bool on: String(Session.prefs.slideshowFolder || "") === modelData[0]
                                width: sf.implicitWidth + 26; height: 32; radius: 16
                                color: on ? Theme.alpha(Theme.accent, 0.22) : Theme.card2; border.color: on ? Theme.accent : Theme.border
                                Text { id: sf; anchors.centerIn: parent; text: modelData[1]; color: on ? Theme.text : Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: Session.setPref("slideshowFolder", modelData[0]) }
                            }
                        }
                    }
                    // the folders inside Imágenes, as more choices
                    FolderListModel {
                        id: subFolderModel
                        folder: w.fileUrl(w.picturesPath)
                        showFiles: false; showDirs: true; showDotAndDotDot: false; showHidden: false
                    }
                    Repeater {
                        id: subFolders
                        property var list: []
                        model: subFolderModel
                        Item {
                            visible: false
                            required property string fileName
                            required property string filePath
                            Component.onCompleted: subFolders.list = subFolders.list.concat([[filePath, fileName]])
                            Component.onDestruction: subFolders.list = subFolders.list.filter(function(x) { return x[0] !== filePath })
                        }
                    }
                }

                // Color sólido
                Flow {
                    visible: w.mode === "color"
                    width: parent.width; spacing: 10
                    Repeater {
                        model: w.gallery ? w.gallery.colors : []
                        Rectangle {
                            required property string modelData
                            readonly property bool on: w.cur && w.cur.kind === "color" && String(w.cur.color) === modelData
                            width: 46; height: 46; radius: 23
                            color: modelData
                            border.color: on ? Theme.accent : Theme.border; border.width: on ? 3 : 1
                            MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: Session.setPrefs({ wallpaper: "color", wallpaperColor: modelData }) }
                        }
                    }
                }

                // Acento
                Text {
                    visible: w.mode === "acento"
                    width: parent.width; wrapMode: Text.Wrap
                    text: "Manchas suaves de tu color de acento sobre el color del tema. Cambia el color en Apariencia."
                    color: Theme.dim; font.family: Theme.font; font.pixelSize: 13
                }

                // Tu foto: the pictures in the person's Imágenes folder
                Column {
                    visible: w.mode === "foto"
                    width: parent.width
                    spacing: 10
                    Text { text: "Elige una foto de"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                    // Imágenes and each folder inside it (the same list the slideshow offers)
                    Flow {
                        width: parent.width; spacing: 8
                        Repeater {
                            model: [[w.picturesPath, "Imágenes"]].concat(subFolders.list)
                            Rectangle {
                                required property var modelData
                                readonly property bool on: w.photoDirShown === modelData[0]
                                width: pf.implicitWidth + 26; height: 32; radius: 16
                                color: on ? Theme.alpha(Theme.accent, 0.22) : Theme.card2; border.color: on ? Theme.accent : Theme.border
                                Behavior on color { ColorAnimation { duration: Theme.ms(140) } }
                                Text { id: pf; anchors.centerIn: parent; text: modelData[1]; color: on ? Theme.text : Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: w.photoDir = modelData[0] }
                            }
                        }
                    }
                    Flow {
                        width: parent.width; spacing: 10
                        Repeater {
                            model: FolderListModel {
                                id: photos
                                folder: w.mode === "foto" ? w.fileUrl(w.photoDirShown) : ""
                                nameFilters: ["*.jpg", "*.jpeg", "*.png", "*.webp", "*.JPG", "*.JPEG", "*.PNG", "*.WEBP"]
                                showDirs: false; showHidden: false
                                sortField: FolderListModel.Time
                            }
                            Rectangle {
                                required property string filePath
                                required property int index
                                readonly property bool on: w.cur && w.cur.id === "custom" && w.cur.file === filePath
                                visible: index < 48
                                width: 140; height: 88; radius: 12
                                color: Theme.card2
                                border.color: on ? Theme.accent : pa.containsMouse ? Theme.dim : Theme.border; border.width: on ? 3 : 1
                                Image {
                                    anchors.fill: parent; anchors.margins: on ? 5 : 3
                                    source: index < 48 ? w.fileUrl(filePath) : ""
                                    sourceSize: Qt.size(280, 176); fillMode: Image.PreserveAspectCrop; asynchronous: true
                                }
                                Rectangle { anchors.fill: parent; anchors.margins: on ? 3 : 1; color: "transparent"; radius: 10; border.color: Theme.bg; border.width: 3 }
                                MouseArea { id: pa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: Session.setPrefs({ wallpaper: "custom", wallpaperFile: filePath }) }
                            }
                        }
                    }
                    Text {
                        visible: photos.count === 0
                        width: parent.width; wrapMode: Text.Wrap
                        text: w.photoDirShown === w.picturesPath
                              ? "Aún no hay fotos aquí. Copia alguna a Imágenes (Archivos → Imágenes) y aparecerá al momento."
                              : "En esta carpeta no hay fotos (JPG, PNG o WebP)."
                        color: Theme.faint; font.family: Theme.font; font.pixelSize: 12
                    }
                    Text { text: "Ajuste"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                    Row {
                        spacing: 8
                        Repeater {
                            model: [["fill", "Rellenar"], ["fit", "Ajustar"], ["center", "Centrar"]]
                            Rectangle {
                                required property var modelData
                                readonly property bool on: String(Session.prefs.wallpaperFit || "fill") === modelData[0]
                                width: ft.implicitWidth + 26; height: 32; radius: 16
                                color: on ? Theme.alpha(Theme.accent, 0.22) : Theme.card2; border.color: on ? Theme.accent : Theme.border
                                Text { id: ft; anchors.centerIn: parent; text: modelData[1]; color: on ? Theme.text : Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                                MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: Session.setPref("wallpaperFit", modelData[0]) }
                            }
                        }
                    }
                }

                Item { width: 1; height: 6 }
                Row {
                    spacing: 12
                    NexusSwitch { anchors.verticalCenter: parent.verticalCenter; checked: Session.prefs.accentAuto === true; onToggled: Session.setPref("accentAuto", checked) }
                    Column {
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: 2
                        Text { text: "Color de acento a juego con el fondo"; color: Theme.text; font.family: Theme.font; font.pixelSize: 14 }
                        Text { text: "Cada imagen de NEXUS trae su color: botones, el dock y la selección lo usan."; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                    }
                }
                Text { text: "La pantalla de bloqueo usa el mismo fondo."; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12 }
            }
        }

        // ---------------- NEXUS AI
        Column {
            visible: w.section === "ai"
            width: Math.min(parent.width, 640)
            spacing: 16
            Row {
                spacing: 12
                NexusMark { width: 30; height: 30; anchors.verticalCenter: parent.verticalCenter }
                Text { text: "NEXUS AI"; color: Theme.text; font.family: Theme.font; font.pixelSize: 24; font.weight: Font.DemiBold }
            }
            Rectangle {
                // grows with its text, so a narrow window wraps it instead of running past the card
                width: parent.width; height: Math.max(64, aiStateCol.height + 26); radius: 14
                color: Theme.card; border.color: Theme.border
                Rectangle { x: 18; y: aiStateCol.y + 6; width: 10; height: 10; radius: 5; color: Session.aiConfigured ? Theme.good : Theme.warn }
                Column {
                    id: aiStateCol
                    x: 40; width: parent.width - x - 18; y: Math.round((Math.max(64, height + 26) - height) / 2)
                    Text { width: parent.width; wrapMode: Text.Wrap; text: Session.aiConfigured ? "Conectada a Claude" : "Sin clave: solo órdenes locales"; color: Theme.text; font.family: Theme.font; font.pixelSize: 15; font.weight: Font.DemiBold }
                    Text { width: parent.width; wrapMode: Text.Wrap; text: Session.aiConfigured ? "Modelo Claude Opus 5.5 · si Claude rechaza una petición, la API la reintenta con otro modelo" : "Abrir apps, la hora, la memoria, apagar… funcionan sin clave y sin Internet"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                }
            }
            Text { width: parent.width; wrapMode: Text.Wrap; text: "Para preguntas abiertas, pega tu clave de la API de Anthropic. Se guarda solo en este equipo y únicamente el servicio NEXUS Engine puede leerla; ni las apps ni el registro de auditoría la ven."; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; lineHeight: 1.25 }
            TextField {
                id: keyField
                width: parent.width
                placeholderText: "sk-ant-…"
                echoMode: TextInput.Password
                color: Theme.text; placeholderTextColor: Theme.faint
                font.family: Theme.mono; font.pixelSize: 14
                background: Rectangle { implicitHeight: 42; radius: 12; color: Theme.card; border.color: keyField.activeFocus ? Theme.accent : Theme.border; border.width: keyField.activeFocus ? 2 : 1 }
                leftPadding: 14
            }
            Row {
                spacing: 10
                Button {
                    id: saveBtn
                    text: "Guardar clave"
                    enabled: keyField.text.length > 10
                    contentItem: Text { text: saveBtn.text; color: "#ffffff"; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.DemiBold; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter; opacity: saveBtn.enabled ? 1 : 0.5 }
                    background: Rectangle { implicitWidth: 140; implicitHeight: 40; radius: 12; color: saveBtn.down ? Qt.darker(Theme.accent, 1.2) : Theme.accent; opacity: saveBtn.enabled ? 1 : 0.5 }
                    onClicked: Session.request("POST", "/ai/key", { key: keyField.text }, function(st, j) {
                        w.keyErr = st !== 200
                        w.keyMsg = st === 200 ? "Clave guardada. NEXUS AI ya puede usar Claude." : (j && j.error ? "No se ha guardado: " + j.error : "No se ha podido guardar (error " + st + ")")
                        if (st === 200) keyField.text = ""
                        Session.refreshSystem()
                    })
                }
                Button {
                    id: delBtn
                    text: "Borrar clave"
                    visible: Session.aiConfigured
                    contentItem: Text { text: delBtn.text; color: Theme.danger; font.family: Theme.font; font.pixelSize: 14; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                    background: Rectangle { implicitWidth: 130; implicitHeight: 40; radius: 12; color: delBtn.hovered ? Theme.alpha(Theme.danger, 0.12) : "transparent"; border.color: Theme.alpha(Theme.danger, 0.5) }
                    onClicked: Session.request("DELETE", "/ai/key", null, function(st, j) { w.keyErr = false; w.keyMsg = st === 200 ? "Clave borrada." : "No se ha podido borrar."; Session.refreshSystem() })
                }
            }
            Text { visible: w.keyMsg !== ""; text: w.keyMsg; color: w.keyErr ? Theme.danger : Theme.good; font.family: Theme.font; font.pixelSize: 13; width: parent.width; wrapMode: Text.Wrap }
        }

        // ---------------- Actualizaciones: NEXUS's own signed updates and Debian's, in the style of Windows Update
        Flickable {
            id: upPage
            visible: w.section === "actualizaciones"
            anchors.fill: parent
            contentWidth: width; contentHeight: upCol.height + 24
            clip: true; boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
            Column {
                id: upCol
                width: Math.min(upPage.width - 14, 880)
                spacing: 14
                Text { text: "Actualizaciones"; color: Theme.text; font.family: Theme.font; font.pixelSize: 24; font.weight: Font.DemiBold }

                // the big card: where things stand, and the one button that moves them on
                Rectangle {
                    id: upCard
                    // narrow (half the screen): the button goes under the text instead of squeezing it to one letter
                    // per line. Positions are computed, not anchored, so the switch works both ways on a resize.
                    readonly property bool stacked: width < 520
                    width: parent.width; radius: 18
                    // the height side by side; things are centred on it (never on the card's own height: no binding loop)
                    readonly property real wideH: Math.max(104, upText.height + 40)
                    height: stacked ? (upBtn.visible ? upBtn.y + upBtn.height + 22 : Math.max(104, upText.y + upText.height + 22)) : wideH
                    color: Theme.card; border.color: Theme.border
                    readonly property string glyph: ({ loading: "busy", checking: "busy", downloading: "busy", installing: "busy", verifying: "busy",
                        idle: "ok", available: "down", ready: "down", reboot: "reboot", error: "warn", unavailable: "warn", checkfail: "warn" })[w.upState] || "ok"
                    readonly property color tint: glyph === "ok" ? Theme.good : glyph === "warn" ? Theme.warn : Theme.accent
                    // the glyph: a soft disc in the state's colour; drawn with Canvas (no icon font needed)
                    Rectangle {
                        id: disc
                        x: 22; y: upCard.stacked ? 22 : Math.round((upCard.wideH - height) / 2)
                        width: 60; height: 60; radius: 30
                        color: Theme.alpha(upCard.tint, 0.16); border.color: Theme.alpha(upCard.tint, 0.45)
                        Behavior on color { ColorAnimation { duration: Theme.ms(300) } }
                        Canvas {
                            id: glyphCanvas
                            anchors.centerIn: parent; width: 32; height: 32
                            property string kind: upCard.glyph
                            property color ink: upCard.tint
                            onKindChanged: requestPaint()
                            onInkChanged: requestPaint()
                            // turns only while busy, and stands straight again the moment it is not (an animator would stop wherever it was)
                            property real spin: 0
                            NumberAnimation on spin { from: 0; to: 360; duration: 1100; loops: Animation.Infinite; running: glyphCanvas.kind === "busy" && Theme.motion }
                            rotation: kind === "busy" ? spin : 0
                            onPaint: {
                                var c = getContext("2d"); c.reset()
                                c.strokeStyle = ink; c.fillStyle = ink; c.lineWidth = 3; c.lineCap = "round"; c.lineJoin = "round"
                                if (kind === "ok") { c.beginPath(); c.moveTo(7, 17); c.lineTo(13.5, 23); c.lineTo(25, 10); c.stroke() }
                                else if (kind === "down") { c.beginPath(); c.moveTo(16, 5); c.lineTo(16, 22); c.moveTo(9, 15.5); c.lineTo(16, 22.5); c.lineTo(23, 15.5); c.moveTo(7, 27); c.lineTo(25, 27); c.stroke() }
                                else if (kind === "warn") { c.beginPath(); c.moveTo(16, 7); c.lineTo(16, 19); c.stroke(); c.beginPath(); c.arc(16, 25.5, 2, 0, 2 * Math.PI); c.fill() }
                                else if (kind === "reboot") { c.beginPath(); c.arc(16, 17, 10, -Math.PI * 0.35, Math.PI * 1.35); c.stroke(); c.beginPath(); c.moveTo(16, 4); c.lineTo(16, 15); c.stroke() }
                                else { c.beginPath(); c.arc(16, 16, 11, 0.2, Math.PI * 1.55); c.stroke(); c.beginPath(); c.moveTo(27.5, 9); c.lineTo(27.2, 16.6); c.lineTo(20, 14.8); c.stroke() }
                            }
                        }
                    }
                    Column {
                        id: upText
                        x: disc.x + disc.width + 18
                        width: upCard.stacked || !upBtn.visible ? parent.width - x - 20 : upBtn.x - x - 18
                        y: upCard.stacked ? Math.max(22, Math.round(disc.y + (disc.height - height) / 2)) : Math.round((upCard.wideH - height) / 2)
                        spacing: 4
                        Text {
                            width: parent.width; wrapMode: Text.Wrap
                            color: Theme.text; font.family: Theme.font; font.pixelSize: 18; font.weight: Font.DemiBold
                            text: ({
                                loading: "Comprobando…",
                                unavailable: "El servicio de actualizaciones no responde",
                                idle: "Estás al día",
                                checkfail: "No se ha podido comprobar",
                                checking: "Buscando actualizaciones…",
                                available: "NEXUS OS " + w.upVersion + " disponible",
                                downloading: "Descargando NEXUS OS " + w.upVersion,
                                ready: "NEXUS OS " + w.upVersion + " lista para instalar",
                                installing: w.up && w.up.message ? String(w.up.message) : "Instalando NEXUS OS " + w.upVersion,
                                verifying: "Comprobando que todo arranca bien…",
                                reboot: "Reinicia para terminar",
                                error: "La actualización no ha salido bien"
                            })[w.upState] || ""
                        }
                        Text {
                            width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.2
                            color: Theme.dim; font.family: Theme.font; font.pixelSize: 13
                            visible: text !== ""
                            text: {
                                var u = w.up || {}
                                if (w.upState === "unavailable") return "Vuelve a intentarlo en unos segundos. Si sigue así, reinicia el ordenador."
                                if (w.upState === "available" && u.available.failedBefore) return "La última vez no arrancó bien en este equipo y se deshizo sola. Puedes reintentarlo o esperar a la siguiente."
                                if (w.upState === "available") return [w.fmtSize(u.available.size), u.available.released ? "publicada " + w.fmtWhen(u.available.released) : ""].filter(Boolean).join(" · ")
                                if (w.upState === "downloading" || w.upState === "installing") return Math.round((u.progress || 0) * 100) + " %"
                                if (w.upState === "ready") return "Tarda unos segundos. El escritorio se recarga y tus ventanas siguen abiertas."
                                if (w.upState === "verifying") return "Si algo fallara, NEXUS vuelve sola a la versión anterior."
                                if (w.upState === "reboot" || w.upState === "error") return u.message || ""
                                if (w.upState === "checkfail") return (u.message || "") + (u.lastCheck ? " Última comprobación buena: " + w.fmtWhen(u.lastCheck) + "." : "")
                                if (w.upState === "idle") return u.message && !/^Estás al día/.test(u.message) ? u.message : u.lastCheck ? "Última comprobación: " + w.fmtWhen(u.lastCheck) : "Aún no se ha buscado ninguna actualización."
                                return ""
                            }
                        }
                        // progress: the bar fills smoothly; while checking it is the busy glyph that moves
                        Rectangle {
                            visible: w.upState === "downloading" || w.upState === "installing" || w.upState === "verifying"
                            width: parent.width; height: 6; radius: 3; color: Theme.card2
                            Rectangle {
                                height: parent.height; radius: 3; color: Theme.accent
                                width: parent.width * Math.max(0.03, w.up && w.up.progress ? w.up.progress : (w.upState === "verifying" ? 0.92 : 0.03))
                                Behavior on width { NumberAnimation { duration: Theme.ms(400); easing.type: Easing.OutCubic } }
                            }
                        }
                    }
                    Rectangle {
                        id: upBtn
                        readonly property var action: ({
                            unavailable: ["Reintentar", function() { Session.refreshUpdate() }],
                            idle: ["Buscar actualizaciones", function() { Session.updateAction("check") }],
                            checkfail: ["Reintentar", function() { Session.updateAction("check") }],
                            available: [w.up && w.up.available && w.up.available.failedBefore ? "Reintentar" : "Descargar e instalar", function() { Session.updateAction("download", "install") }],
                            ready: ["Instalar ahora", function() { Session.updateAction("install") }],
                            reboot: ["Reiniciar ahora", function() { Session.power("reboot") }],
                            // never straight back into what just failed: look again first (a version that was undone by
                            // itself then shows as such, and trying it again is a choice made knowingly)
                            error: ["Buscar actualizaciones", function() { Session.updateAction("check") }]
                        })[w.upState] || null
                        visible: action !== null
                        x: upCard.stacked ? upText.x : parent.width - width - 20
                        y: upCard.stacked ? Math.max(disc.y + disc.height, upText.y + upText.height) + 14 : Math.round((upCard.wideH - height) / 2)
                        width: ubt.implicitWidth + 36; height: 40; radius: 12
                        color: uba.pressed ? Qt.darker(Theme.accent, 1.2) : uba.containsMouse ? Qt.lighter(Theme.accent, 1.1) : Theme.accent
                        Behavior on color { ColorAnimation { duration: Theme.ms(120) } }
                        Text { id: ubt; anchors.centerIn: parent; text: upBtn.action ? upBtn.action[0] : ""; color: "#ffffff"; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.DemiBold }
                        MouseArea { id: uba; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: if (upBtn.action) upBtn.action[1]() }
                    }
                }

                // what the new version brings
                Rectangle {
                    visible: !!(w.up && w.up.available && w.up.available.notes && w.up.available.notes.length) && w.upState !== "idle"
                    width: parent.width; height: notesCol.height + 32; radius: 16
                    color: Theme.card; border.color: Theme.border
                    Column {
                        id: notesCol
                        x: 20; y: 16; width: parent.width - 40
                        spacing: 8
                        Text { text: "Novedades de NEXUS OS " + w.upVersion; color: Theme.text; font.family: Theme.font; font.pixelSize: 15; font.weight: Font.DemiBold }
                        Repeater {
                            model: w.up && w.up.available ? w.up.available.notes : []
                            Row {
                                required property string modelData
                                spacing: 10
                                Rectangle { y: 7; width: 6; height: 6; radius: 3; color: Theme.accent }
                                Text { width: notesCol.width - 16; wrapMode: Text.Wrap; text: modelData; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; lineHeight: 1.2 }
                            }
                        }
                    }
                }

                // Debian: the base system's own updates (security fixes and the like)
                Rectangle {
                    readonly property var deb: w.up && w.up.debian ? w.up.debian : null
                    visible: !!deb
                    width: parent.width; height: 76; radius: 16
                    color: Theme.card; border.color: Theme.border
                    Column {
                        x: 20; anchors.verticalCenter: parent.verticalCenter
                        width: parent.width - 40 - debBtn.width - 16
                        spacing: 3
                        Text { text: "Sistema base (Debian)"; color: Theme.text; font.family: Theme.font; font.pixelSize: 15; font.weight: Font.DemiBold }
                        Text {
                            width: parent.width; elide: Text.ElideRight
                            color: Theme.dim; font.family: Theme.font; font.pixelSize: 12
                            text: {
                                var d = parent.parent.deb
                                if (!d) return ""
                                if (d.state === "checking") return "Buscando actualizaciones de Debian…"
                                if (d.state === "installing") return "Instalando… " + Math.round((d.progress || 0) * 100) + " %"
                                if (d.message && d.count === 0) return d.message
                                if (d.count > 0) return d.count + (d.count === 1 ? " actualización" : " actualizaciones") + " de seguridad y mejoras: " + d.packages.slice(0, 3).map(function(p) { return p.name }).join(", ") + (d.count > 3 ? "…" : "")
                                return d.checkedAt ? "Al día · última comprobación: " + w.fmtWhen(d.checkedAt) : "Seguridad y mejoras de los programas de base"
                            }
                        }
                    }
                    Rectangle {
                        id: debBtn
                        readonly property var deb: parent.deb
                        readonly property bool busy: !!deb && (deb.state === "checking" || deb.state === "installing")
                        readonly property bool install: !!deb && deb.count > 0
                        anchors.right: parent.right; anchors.rightMargin: 18; anchors.verticalCenter: parent.verticalCenter
                        width: dbt.implicitWidth + 30; height: 36; radius: 11
                        opacity: busy ? 0.5 : 1
                        color: install ? (dba.containsMouse ? Qt.lighter(Theme.accent, 1.1) : Theme.accent) : (dba.containsMouse ? Theme.hover : Theme.card2)
                        border.color: install ? "transparent" : Theme.border
                        Text { id: dbt; anchors.centerIn: parent; text: debBtn.install ? "Instalar" : "Buscar"; color: debBtn.install ? "#ffffff" : Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
                        MouseArea { id: dba; anchors.fill: parent; hoverEnabled: true; enabled: !debBtn.busy; cursorShape: Qt.PointingHandCursor; onClicked: Session.updateAction(debBtn.install ? "debian-install" : "debian-check") }
                    }
                }

                // automatic downloads
                Row {
                    visible: !!(w.up && !w.up.unavailable)
                    spacing: 12
                    NexusSwitch { anchors.verticalCenter: parent.verticalCenter; checked: !!(w.up && w.up.autoDownload); onToggled: Session.updateAction("auto", checked) }
                    Column {
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: 2
                        Text { width: upCol.width - 64; wrapMode: Text.Wrap; text: "Descargar las actualizaciones de NEXUS automáticamente"; color: Theme.text; font.family: Theme.font; font.pixelSize: 14 }
                        Text { width: upCol.width - 64; wrapMode: Text.Wrap; text: "NEXUS mira cada 6 horas. Instalar siempre lo decides tú."; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                    }
                }

                // history
                // (the newest first; four of them unless asked for all)
                Item {
                    id: histHead
                    property bool all: false
                    readonly property int total: w.up && w.up.history ? w.up.history.length : 0
                    visible: total > 0
                    width: parent.width; height: 30
                    Text { anchors.bottom: parent.bottom; anchors.bottomMargin: 2; text: "Historial de actualizaciones"; color: Theme.text; font.family: Theme.font; font.pixelSize: 15; font.weight: Font.DemiBold }
                    Text {
                        visible: histHead.total > 4
                        anchors.right: parent.right; anchors.bottom: parent.bottom; anchors.bottomMargin: 3
                        text: histHead.all ? "Ver menos" : "Ver todo (" + histHead.total + ")"
                        color: hva.containsMouse ? Theme.text : Theme.accent; font.family: Theme.font; font.pixelSize: 13
                        MouseArea { id: hva; anchors.fill: parent; anchors.margins: -6; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: histHead.all = !histHead.all }
                    }
                }
                Column {
                    width: parent.width
                    spacing: 6
                    Repeater {
                        id: histRep
                        model: w.up && w.up.history ? (histHead.all ? w.up.history : w.up.history.slice(0, 4)) : []
                        Rectangle {
                            required property var modelData
                            readonly property bool good: modelData.result === "installed" || modelData.result === "repaired"
                            width: parent.width; height: hcol.height + 22; radius: 12
                            color: Theme.card; border.color: Theme.border
                            Rectangle { x: 16; anchors.verticalCenter: parent.verticalCenter; width: 8; height: 8; radius: 4; color: parent.good ? Theme.good : modelData.result === "undone" ? Theme.dim : Theme.warn }
                            Column {
                                id: hcol
                                x: 36; anchors.verticalCenter: parent.verticalCenter
                                width: parent.width - 52
                                spacing: 2
                                Text {
                                    width: parent.width; elide: Text.ElideRight
                                    text: (modelData.kind === "debian" ? "Debian · " + modelData.version : "NEXUS OS " + modelData.version) + "  ·  " + ({ installed: "instalada", "rolled-back": "deshecha sola (no arrancaba bien)", undone: "deshecha por ti", failed: "no se pudo instalar", repaired: "paquetes reparados" })[modelData.result] || modelData.result
                                    color: Theme.text; font.family: Theme.font; font.pixelSize: 13
                                }
                                Text {
                                    width: parent.width; wrapMode: Text.Wrap
                                    text: w.fmtWhen(modelData.at) + (modelData.from && modelData.from !== modelData.version ? " · desde " + modelData.from : "") + (modelData.detail ? " · " + modelData.detail : "")
                                    color: Theme.faint; font.family: Theme.font; font.pixelSize: 12
                                }
                            }
                        }
                    }
                }

                // going back: only to the version right before the last update (its saved copy)
                // (asks first, right here: "Volver" only appears after the first click)
                Item {
                    id: undoBox
                    property bool asking: false
                    visible: !!(w.up && w.up.canUndo) && w.upState === "idle"
                    onVisibleChanged: if (!visible) asking = false
                    width: parent.width; height: asking ? undoAsk.height : 38
                    Rectangle {
                        visible: !undoBox.asking
                        width: undoTxt.implicitWidth + 34; height: 38; radius: 12
                        color: una.containsMouse ? Theme.hover : "transparent"; border.color: Theme.border
                        Text { id: undoTxt; anchors.centerIn: parent; text: w.up && w.up.canUndo ? "Volver a NEXUS OS " + w.up.canUndo.version : ""; color: Theme.text; font.family: Theme.font; font.pixelSize: 13 }
                        MouseArea { id: una; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: undoBox.asking = true }
                    }
                    Rectangle {
                        id: undoAsk
                        visible: undoBox.asking
                        width: parent.width; height: 64; radius: 14
                        color: Theme.alpha(Theme.warn, 0.10); border.color: Theme.alpha(Theme.warn, 0.40)
                        Text {
                            x: 18; anchors.verticalCenter: parent.verticalCenter
                            width: parent.width - 36 - askBtns.width - 12; wrapMode: Text.Wrap
                            text: w.up && w.up.canUndo ? "¿Volver a NEXUS OS " + w.up.canUndo.version + "? Se deshace la última actualización y el escritorio se recarga." : ""
                            color: Theme.text; font.family: Theme.font; font.pixelSize: 13
                        }
                        Row {
                            id: askBtns
                            anchors.right: parent.right; anchors.rightMargin: 14; anchors.verticalCenter: parent.verticalCenter
                            spacing: 8
                            Rectangle {
                                width: cnt.implicitWidth + 26; height: 34; radius: 10
                                color: cna.containsMouse ? Theme.hover : Theme.card2; border.color: Theme.border
                                Text { id: cnt; anchors.centerIn: parent; text: "Cancelar"; color: Theme.text; font.family: Theme.font; font.pixelSize: 13 }
                                MouseArea { id: cna; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: undoBox.asking = false }
                            }
                            Rectangle {
                                width: vlt.implicitWidth + 26; height: 34; radius: 10
                                color: vla.containsMouse ? Qt.lighter(Theme.warn, 1.1) : Theme.warn
                                Text { id: vlt; anchors.centerIn: parent; text: "Volver"; color: "#1a1206"; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
                                MouseArea { id: vla; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: { undoBox.asking = false; Session.updateAction("undo") } }
                            }
                        }
                    }
                }

                // what is installed
                Text {
                    visible: !!(w.up && w.up.versions)
                    width: parent.width; wrapMode: Text.Wrap; topPadding: 6; lineHeight: 1.3
                    color: Theme.faint; font.family: Theme.font; font.pixelSize: 12
                    text: {
                        var v = w.up && w.up.versions ? w.up.versions : {}
                        return ["NEXUS OS " + (v.nexus || "?"), v.claudeCode ? "Claude Code " + v.claudeCode : "", v.labwc ? "labwc " + v.labwc : "", v.debian ? "Debian " + v.debian : "", v.kernel ? "Linux " + v.kernel : ""].filter(Boolean).join(" · ")
                             + (v.channel ? "\nCanal de actualizaciones: " + v.channel + " · todo lo que llega va firmado por NEXUS" : "")
                    }
                }
            }
        }

        // ---------------- Acerca de
        Column {
            visible: w.section === "acerca"
            width: Math.min(parent.width, 640)
            spacing: 14
            Row {
                spacing: 18
                NexusMark { width: 64; height: 64 }
                Column {
                    anchors.verticalCenter: parent.verticalCenter
                    Text { text: "NEXUS OS"; color: Theme.text; font.family: Theme.font; font.pixelSize: 28; font.weight: Font.Bold; font.letterSpacing: 1 }
                    Text { text: w.sys ? w.sys.os : ""; color: Theme.dim; font.family: Theme.font; font.pixelSize: 14 }
                }
            }
            Item { width: 1; height: 6 }
            Repeater {
                model: w.sys ? [
                    ["Equipo", w.sys.hostname],
                    ["Procesador", w.sys.cpu.cores + " núcleos (" + w.sys.arch + ")"],
                    ["Memoria", w.fmtBytes(w.sys.memory.totalBytes)],
                    ["Disco", w.sys.disk ? w.fmtBytes(w.sys.disk.totalBytes) + " (" + w.fmtBytes(w.sys.disk.availableBytes) + " libres)" : "–"],
                    ["Núcleo Linux", w.sys.kernel],
                    ["Aislamiento de agentes", w.sys.engine && w.sys.engine.isolation.available ? w.sys.engine.isolation.mechanism + " (bubblewrap + cgroups)" : "no disponible"],
                    ["Red", w.sys.network.length ? w.sys.network[0].address : "sin conexión"]
                ] : []
                Rectangle {
                    id: infoRow
                    required property var modelData
                    // label and value side by side; when they do not both fit, the value goes under the label
                    readonly property bool fits: infoLbl.implicitWidth + infoVal.implicitWidth + 56 <= width
                    width: parent.width; height: fits ? 44 : 64; radius: 10
                    color: Theme.card; border.color: Theme.border
                    Text { id: infoLbl; x: 16; y: infoRow.fits ? Math.round((44 - height) / 2) : 12; text: infoRow.modelData[0]; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                    Text {
                        id: infoVal
                        x: infoRow.fits ? infoRow.width - implicitWidth - 16 : 16
                        y: infoRow.fits ? Math.round((44 - height) / 2) : infoLbl.y + infoLbl.height + 4
                        width: infoRow.fits ? implicitWidth : infoRow.width - 32
                        elide: Text.ElideRight
                        text: infoRow.modelData[1]; color: Theme.text; font.family: Theme.font; font.pixelSize: 13
                    }
                }
            }
        }
    }
}
