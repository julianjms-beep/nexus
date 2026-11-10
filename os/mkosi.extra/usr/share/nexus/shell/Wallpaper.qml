import QtQuick
import QtQuick.Window
import org.kde.layershell 1.0 as LayerShell

Window {
    id: w
    visible: true
    color: Theme.bg
    LayerShell.Window.scope: "nexus-wallpaper"
    LayerShell.Window.layer: LayerShell.Window.LayerBackground
    LayerShell.Window.anchors: LayerShell.Window.AnchorTop | LayerShell.Window.AnchorBottom | LayerShell.Window.AnchorLeft | LayerShell.Window.AnchorRight
    LayerShell.Window.exclusionZone: -1
    LayerShell.Window.keyboardInteractivity: LayerShell.Window.KeyboardInteractivityNone

    // ---------------------------------------------------------------- the background
    // nexus-sessiond decides what is on screen (core/src/wallpaper.ts: theme, hour, slideshow) and says so in
    // Session.wallpaper. A picture is decoded off-screen at the screen's size, then fades in over the previous one.
    readonly property var wp: Session.wallpaper
    readonly property string kind: wp ? String(wp.kind) : "image"
    readonly property bool lightInk: wp ? wp.ink !== "dark" : Theme.dark
    readonly property color ink: lightInk ? "#ffffff" : "#151a2b"
    readonly property color inkDim: lightInk ? Qt.rgba(1, 1, 1, 0.78) : Qt.rgba(0.08, 0.10, 0.17, 0.72)
    function fileUrl(p) { return p ? "file://" + String(p).split("/").map(encodeURIComponent).join("/") : "" }
    readonly property string want: kind === "image" && wp && wp.file ? fileUrl(wp.file) : ""
    readonly property int fillMode: wp && wp.fit === "fit" ? Image.PreserveAspectFit : wp && wp.fit === "center" ? Image.Pad : Image.PreserveAspectCrop
    property int top: 0          // which of the two layers is in front
    onWantChanged: swapTo(want)
    Component.onCompleted: swapTo(want)
    function swapTo(src) {
        var front = top === 0 ? layerA : layerB, back = top === 0 ? layerB : layerA
        if (!src) { front.opacity = 0; back.opacity = 0; return }
        if (front.wanted === src && front.opacity > 0) return
        back.z = 1; front.z = 0
        back.opacity = 0
        back.wanted = src
        back.source = src          // shown when it is ready (onStatusChanged)
    }
    function layerReady(l) {
        if (l.status !== Image.Ready || l.wanted !== w.want) return
        var mine = l === layerA ? 0 : 1
        if (w.top !== mine) { w.top = mine; l.opacity = 1; fadeOld.restart() } else l.opacity = 1
    }
    readonly property size decodeSize: Qt.size(Math.ceil(w.width * Screen.devicePixelRatio), Math.ceil(w.height * Screen.devicePixelRatio))
    Item {   // the two layers stack only among themselves (the clock and the widgets stay above)
        anchors.fill: parent
        Image {
            id: layerA
            anchors.fill: parent
            property string wanted: ""   // the url as asked for (Qt shows it decoded: "Imágenes")
            asynchronous: true; cache: false; smooth: true
            fillMode: w.fillMode
            sourceSize: w.fillMode === Image.Pad ? undefined : w.decodeSize
            opacity: 0
            visible: opacity > 0.001
            Behavior on opacity { NumberAnimation { duration: Theme.ms(700); easing.type: Easing.InOutQuad } }
            onStatusChanged: w.layerReady(layerA)
        }
        Image {
            id: layerB
            anchors.fill: parent
            property string wanted: ""   // the url as asked for (Qt shows it decoded: "Imágenes")
            asynchronous: true; cache: false; smooth: true
            fillMode: w.fillMode
            sourceSize: w.fillMode === Image.Pad ? undefined : w.decodeSize
            opacity: 0
            visible: opacity > 0.001
            Behavior on opacity { NumberAnimation { duration: Theme.ms(700); easing.type: Easing.InOutQuad } }
            onStatusChanged: w.layerReady(layerB)
        }
    }
    // once the new picture is fully in, the old layer lets go of its (large) image
    Timer {
        id: fadeOld
        interval: Theme.ms(700) + 50
        onTriggered: { var old = w.top === 0 ? layerB : layerA; old.opacity = 0; old.source = ""; old.wanted = "" }
    }
    // a solid colour
    Rectangle { anchors.fill: parent; visible: w.kind === "color"; color: w.wp && w.wp.color ? w.wp.color : Theme.bg }
    // one of the person's own pictures: the middle is softened a little so the clock always reads
    Rectangle {
        anchors.fill: parent
        visible: !!(w.wp && w.wp.scrim) && w.kind === "image"
        gradient: Gradient {
            GradientStop { position: 0.10; color: "transparent" }
            GradientStop { position: 0.36; color: Qt.rgba(0, 0, 0, 0.30) }
            GradientStop { position: 0.58; color: Qt.rgba(0, 0, 0, 0.26) }
            GradientStop { position: 0.80; color: "transparent" }
        }
    }

    // Acento: soft colour fields in the person's accent colour, painted once per size/theme change (cheap even with
    // software rendering).
    Canvas {
        id: aurora
        anchors.fill: parent
        visible: w.kind === "accent"
        onVisibleChanged: if (visible) requestPaint()
        onPaint: {
            var ctx = getContext("2d"), W = width, H = height
            ctx.reset()
            ctx.fillStyle = Theme.bg; ctx.fillRect(0, 0, W, H)
            function blob(x, y, r, rgb, a) {
                var g = ctx.createRadialGradient(x, y, 0, x, y, r)
                g.addColorStop(0, "rgba(" + rgb + "," + a + ")")
                g.addColorStop(0.55, "rgba(" + rgb + "," + (a * 0.35) + ")")
                g.addColorStop(1, "rgba(" + rgb + ",0)")
                ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)
            }
            var d = Theme.dark
            var ac = Math.round(Theme.accent.r * 255) + "," + Math.round(Theme.accent.g * 255) + "," + Math.round(Theme.accent.b * 255)
            blob(W * 0.16, H * 0.22, Math.max(W, H) * 0.55, ac, d ? 0.55 : 0.35)
            blob(W * 0.88, H * 0.12, Math.max(W, H) * 0.42, "56,217,255", d ? 0.32 : 0.25)
            blob(W * 0.72, H * 1.02, Math.max(W, H) * 0.60, "255,92,170", d ? 0.26 : 0.18)
            blob(W * 0.38, H * 0.95, Math.max(W, H) * 0.35, "61,220,151", d ? 0.10 : 0.10)
        }
        onWidthChanged: requestPaint()
        onHeightChanged: requestPaint()
        Connections {
            target: Theme
            function onDarkChanged() { aurora.requestPaint() }
            function onAccentChanged() { aurora.requestPaint() }
        }
    }

    // right click on the desktop: change the wallpaper (and skip ahead during a slideshow)
    MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.RightButton
        onClicked: (m) => { deskMenu.x = Math.min(m.x, w.width - deskMenu.width - 8); deskMenu.y = Math.min(m.y, w.height - deskMenu.height - 8); deskMenu.visible = true }
    }

    // Widgets (right column): weather and the "Hoy" list.
    // The "barra" desktop is only the picture and the taskbar (the look the person drew on 09-11): no widgets, no clock.
    Column {
        visible: Session.layout === "clasico"
        anchors.right: parent.right; anchors.rightMargin: 28
        y: 58 + 14
        spacing: 16
        WeatherCard {}
        TodayCard {}
    }

    // Desktop greeting: time, date and how to talk to NEXUS.
    Column {
        visible: Session.layout === "clasico"
        opacity: Session.overlay ? 0 : 1
        Behavior on opacity { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
        anchors.centerIn: parent
        anchors.verticalCenterOffset: -parent.height * 0.05   // the clock's centre near 38 % of the height, as in the concept
        spacing: 0
        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            text: Qt.formatTime(Session.now, Session.clock24 ? "HH:mm" : "h:mm")
            color: w.ink
            Behavior on color { ColorAnimation { duration: Theme.ms(500) } }
            style: w.lightInk && w.kind === "image" ? Text.Raised : Text.Normal
            styleColor: Qt.rgba(0, 0, 0, 0.18)
            font.family: "Inter Display"; font.pixelSize: Math.round(w.height * 0.22); font.weight: Font.ExtraLight
        }
        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            text: { var t = Session.now.toLocaleDateString(Qt.locale("es_ES"), "dddd, d 'de' MMMM"); return t.charAt(0).toUpperCase() + t.slice(1) }
            color: w.kind === "accent" ? (Theme.dark ? Qt.tint(Theme.dim, Theme.alpha(Theme.accent, 0.35)) : Theme.dim) : w.inkDim
            Behavior on color { ColorAnimation { duration: Theme.ms(500) } }
            font.family: Theme.font; font.pixelSize: Math.round(w.height * 0.040)
        }
        Item { width: 1; height: Math.round(w.height * 0.045) }
        Rectangle {
            id: ask
            anchors.horizontalCenter: parent.horizontalCenter
            width: hintRow.width + 44; height: 64; radius: 32
            // violet glass, a little lighter than the widgets, as in the concept
            color: Theme.dark ? Qt.rgba(0.17, 0.15, 0.34, (askMa.containsMouse ? 0.66 : 0.50) + (Theme.wallLight ? 0.30 : 0))
                              : (askMa.containsMouse ? Qt.tint(Theme.panel, Theme.hover) : Theme.panel)
            border.color: Theme.dark ? Qt.rgba(1, 1, 1, 0.18) : Theme.border
            Row {
                id: hintRow
                anchors.centerIn: parent
                spacing: 16
                NexusMark { width: 28; height: 28; anchors.verticalCenter: parent.verticalCenter }
                Rectangle { width: 1; height: 30; color: Theme.border; anchors.verticalCenter: parent.verticalCenter }
                Text { anchors.verticalCenter: parent.verticalCenter; text: "Pregunta a NEXUS"; color: Theme.text; font.family: Theme.font; font.pixelSize: 19; font.weight: Font.DemiBold }
                Item { width: 18; height: 1 }
                Rectangle {
                    anchors.verticalCenter: parent.verticalCenter
                    width: kbd.implicitWidth + 22; height: 34; radius: 10
                    color: Theme.hover; border.color: Theme.border
                    Text { id: kbd; anchors.centerIn: parent; text: "Super + Espacio"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 14 }
                }
            }
            MouseArea { id: askMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: Session.openPanel("ai") }
        }
    }

    // the desktop's small menu (right click)
    Rectangle {
        id: deskMenu
        visible: false
        z: 50
        width: 230; height: menuCol.height + 12
        radius: 12
        color: Theme.card; border.color: Theme.border
        Column {
            id: menuCol
            x: 6; y: 6; width: parent.width - 12
            Repeater {
                model: (Session.wallpaper && Session.wallpaper.id === "slideshow") ? [["next", "Siguiente fondo"], ["settings", "Cambiar el fondo…"]] : [["settings", "Cambiar el fondo…"]]
                Rectangle {
                    required property var modelData
                    width: menuCol.width; height: 36; radius: 8
                    color: mi.containsMouse ? Theme.hover : "transparent"
                    Text { x: 12; anchors.verticalCenter: parent.verticalCenter; text: modelData[1]; color: Theme.text; font.family: Theme.font; font.pixelSize: 14 }
                    MouseArea {
                        id: mi; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                        onClicked: { deskMenu.visible = false; if (modelData[0] === "next") Session.nextWallpaper(); else Session.openSettings("fondo") }
                    }
                }
            }
        }
    }
    // any other click closes it
    MouseArea { anchors.fill: parent; z: 49; visible: deskMenu.visible; acceptedButtons: Qt.LeftButton | Qt.RightButton; onClicked: deskMenu.visible = false }
}
