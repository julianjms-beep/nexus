import QtQuick
import QtQuick.Window
import org.kde.layershell 1.0 as LayerShell

// Desktop notices (Session's "notice" events: update ready, AI done, …), top right under the bar.
// They slide in, stay 4.5 s (longer while the pointer rests on one), and fold away; a click closes one.
Window {
    id: t
    visible: toasts.count > 0
    color: "transparent"
    width: 380
    height: Math.max(1, col.height + 20)
    LayerShell.Window.scope: "nexus-toasts"
    LayerShell.Window.layer: LayerShell.Window.LayerOverlay
    LayerShell.Window.anchors: LayerShell.Window.AnchorTop | LayerShell.Window.AnchorRight
    LayerShell.Window.exclusionZone: 0
    LayerShell.Window.keyboardInteractivity: LayerShell.Window.KeyboardInteractivityNone

    readonly property int life: 4500
    readonly property int fold: 260
    function show(text, kind) {
        toasts.append({ body: text, kind: kind || "info", born: Date.now(), gone: 0, held: false })
        var live = 0
        for (var i = toasts.count - 1; i >= 0; i--) if (!toasts.get(i).gone && ++live > 4) toasts.setProperty(i, "gone", Date.now())
        sweep.restart()
    }
    function dismiss(i) { if (i >= 0 && i < toasts.count && !toasts.get(i).gone) toasts.setProperty(i, "gone", Date.now()) }
    ListModel { id: toasts }
    Timer {
        id: sweep; interval: 200; repeat: true
        onTriggered: {
            var now = Date.now()
            for (var i = toasts.count - 1; i >= 0; i--) {
                var e = toasts.get(i)
                if (e.gone && now - e.gone > Theme.ms(t.fold) + 40) toasts.remove(i)
                else if (!e.gone && e.held) toasts.setProperty(i, "born", now - t.life + 1500)   // after the pointer leaves: 1.5 s more
                else if (!e.gone && now - e.born > t.life) toasts.setProperty(i, "gone", now)
            }
            if (toasts.count === 0) stop()
        }
    }
    Column {
        id: col
        x: 10; y: 10
        width: parent.width - 20
        Repeater {
            model: toasts
            Item {
                id: slot
                required property int index
                required property string body
                required property string kind
                required property real gone
                width: col.width
                // the slot folds to nothing as the toast leaves, so the ones below glide up instead of jumping
                height: gone ? 0 : card.height + 8
                clip: gone !== 0
                Behavior on height { NumberAnimation { duration: Theme.ms(t.fold); easing.type: Easing.OutCubic } }
                Rectangle {
                    id: card
                    width: parent.width
                    height: label.implicitHeight + 28
                    radius: 14
                    color: Theme.card
                    border.color: hover.containsMouse ? Theme.alpha(Theme.text, 0.18) : Theme.border
                    opacity: 0
                    x: 36
                    Component.onCompleted: { opacity = Qt.binding(function() { return slot.gone ? 0 : 1 }); x = Qt.binding(function() { return slot.gone ? 24 : 0 }) }
                    Behavior on opacity { NumberAnimation { duration: Theme.ms(220); easing.type: Easing.OutCubic } }
                    Behavior on x { NumberAnimation { duration: Theme.ms(320); easing.type: Easing.OutCubic } }
                    Rectangle {
                        x: 14; anchors.verticalCenter: parent.verticalCenter; width: 8; height: 8; radius: 4
                        color: slot.kind === "warn" ? Theme.warn : slot.kind === "good" ? Theme.good : Theme.accent
                    }
                    Text { id: label; x: 32; width: parent.width - 46; anchors.verticalCenter: parent.verticalCenter; text: slot.body; wrapMode: Text.Wrap; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; lineHeight: 1.15 }
                    MouseArea {
                        id: hover
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onContainsMouseChanged: if (!slot.gone) toasts.setProperty(slot.index, "held", containsMouse)
                        onClicked: t.dismiss(slot.index)
                    }
                }
            }
        }
    }
}
