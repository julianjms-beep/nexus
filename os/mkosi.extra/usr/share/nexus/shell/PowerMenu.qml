import QtQuick
import QtQuick.Window
import org.kde.layershell 1.0 as LayerShell

Window {
    id: menu
    visible: false
    color: "transparent"
    LayerShell.Window.scope: "nexus-power"
    LayerShell.Window.layer: LayerShell.Window.LayerOverlay
    LayerShell.Window.anchors: LayerShell.Window.AnchorTop | LayerShell.Window.AnchorBottom | LayerShell.Window.AnchorLeft | LayerShell.Window.AnchorRight
    LayerShell.Window.exclusionZone: -1
    LayerShell.Window.keyboardInteractivity: LayerShell.Window.KeyboardInteractivityExclusive

    // shown drives the animation; the window itself goes away only once the card has faded out
    property bool shown: false
    function open() { hideLater.stop(); visible = true; shown = true; requestActivate(); list.forceActiveFocus() }
    function close() { if (!shown) return; shown = false; hideLater.restart() }
    function toggle() { if (shown) close(); else open() }
    Timer { id: hideLater; interval: Theme.ms(150) + 10; onTriggered: if (!menu.shown) menu.visible = false }
    function pick(action) {
        close()
        if (action === "lock") Session.power("lock")
        else Session.askLocalConfirm(action)
    }

    MouseArea { anchors.fill: parent; onClicked: menu.close() }
    Rectangle {
        anchors.right: parent.right; anchors.rightMargin: 12
        y: Session.layout === "barra" ? 38 : 60   // under the menu bar ("barra") or the top bar ("clasico")
        width: 230
        height: list.height + 16
        radius: 16
        color: Theme.card
        border.color: Theme.border
        // drops in from the power button: a short fade and a slight grow from its top-right corner
        opacity: menu.shown ? 1 : 0
        scale: menu.shown ? 1 : 0.94
        transformOrigin: Item.TopRight
        Behavior on opacity { NumberAnimation { duration: Theme.ms(menu.shown ? 170 : 130); easing.type: Easing.OutCubic } }
        Behavior on scale { NumberAnimation { duration: Theme.ms(menu.shown ? 220 : 130); easing.type: Easing.OutCubic } }
        MouseArea { anchors.fill: parent }
        Column {
            id: list
            x: 8; y: 8
            width: parent.width - 16
            focus: true
            Keys.onEscapePressed: menu.close()
            Repeater {
                model: [["lock", "Bloquear pantalla", "Super + L"], ["logout", "Cerrar sesión", ""], ["reboot", "Reiniciar…", ""], ["poweroff", "Apagar…", ""]]
                Rectangle {
                    required property var modelData
                    width: list.width; height: 40; radius: 10
                    color: ia.containsMouse ? Theme.hover : "transparent"
                    Behavior on color { ColorAnimation { duration: Theme.ms(90) } }
                    Text { x: 14; anchors.verticalCenter: parent.verticalCenter; text: modelData[1]; color: modelData[0] === "poweroff" ? Theme.danger : Theme.text; font.family: Theme.font; font.pixelSize: 14 }
                    Text { anchors.right: parent.right; anchors.rightMargin: 12; anchors.verticalCenter: parent.verticalCenter; text: modelData[2]; color: Theme.faint; font.family: Theme.font; font.pixelSize: 11 }
                    MouseArea { id: ia; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: menu.pick(modelData[0]) }
                }
            }
        }
    }
}
