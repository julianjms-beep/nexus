import QtQuick
import QtQuick.Window
import QtQuick.Controls
import org.kde.layershell 1.0 as LayerShell

// Human confirmation for power actions. Nothing happens unless the person clicks the confirm button.
Window {
    id: dlg
    visible: false
    color: "transparent"
    LayerShell.Window.scope: "nexus-confirm"
    LayerShell.Window.layer: LayerShell.Window.LayerOverlay
    LayerShell.Window.anchors: LayerShell.Window.AnchorTop | LayerShell.Window.AnchorBottom | LayerShell.Window.AnchorLeft | LayerShell.Window.AnchorRight
    LayerShell.Window.exclusionZone: -1
    LayerShell.Window.keyboardInteractivity: LayerShell.Window.KeyboardInteractivityExclusive

    property string cid: ""
    property string action: ""
    property string reason: ""
    property string origin: ""
    readonly property var texts: ({
        poweroff: ["¿Apagar el equipo?", "Apagar"],
        reboot: ["¿Reiniciar el equipo?", "Reiniciar"],
        lock: ["¿Bloquear la pantalla?", "Bloquear"],
        logout: ["¿Cerrar la sesión?", "Cerrar sesión"]
    })
    readonly property bool destructive: action === "poweroff" || action === "reboot" || action === "logout"

    function ask(id, act, why, from) {
        if (visible && cid && cid !== id) Session.confirm(cid, false) // a newer request replaces an older pending one
        cid = id; action = act; reason = why; origin = from
        hideLater.stop()
        visible = true
        shown = true
        requestActivate()
        cancelBtn.forceActiveFocus()
        expiry.restart()
    }
    function finish(approve) {
        expiry.stop()
        if (cid) Session.confirm(cid, approve)
        else if (approve) Session.power(action)
        cid = ""; shown = false; hideLater.restart()
    }
    // shown drives the fade; the window goes away once it has faded (a new ask() in between keeps it)
    property bool shown: false
    Timer { id: hideLater; interval: Theme.ms(140) + 10; onTriggered: if (!dlg.shown) dlg.visible = false }
    Timer { id: expiry; interval: 110000; onTriggered: dlg.finish(false) }

    Rectangle {
        anchors.fill: parent
        color: Qt.rgba(0.02, 0.03, 0.06, 0.6)
        opacity: dlg.shown ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: Theme.ms(dlg.shown ? 200 : 140); easing.type: Easing.OutCubic } }
        MouseArea { anchors.fill: parent; onClicked: dlg.finish(false) }
    }
    Rectangle {
        id: card
        width: 440
        height: col.implicitHeight + 48
        anchors.centerIn: parent
        radius: 22
        color: Theme.card
        border.color: Theme.border
        opacity: dlg.shown ? 1 : 0
        scale: dlg.shown ? 1 : 0.95
        Behavior on opacity { NumberAnimation { duration: Theme.ms(dlg.shown ? 200 : 140); easing.type: Easing.OutCubic } }
        Behavior on scale { NumberAnimation { duration: Theme.ms(dlg.shown ? 260 : 140); easing.type: Easing.OutBack; easing.overshoot: 1.2 } }
        MouseArea { anchors.fill: parent }
        Keys.onEscapePressed: dlg.finish(false)
        Column {
            id: col
            x: 28; y: 28
            width: parent.width - 56
            spacing: 14
            Rectangle {
                width: 52; height: 52; radius: 26
                color: Theme.alpha(dlg.destructive ? Theme.danger : Theme.accent, 0.16)
                PowerGlyph { anchors.centerIn: parent; width: 22; height: 22; color: dlg.destructive ? Theme.danger : Theme.accent }
            }
            Text {
                width: parent.width
                text: (dlg.texts[dlg.action] || ["¿Continuar?", "Aceptar"])[0]
                color: Theme.text; font.family: Theme.font; font.pixelSize: 21; font.weight: Font.DemiBold
                wrapMode: Text.Wrap
            }
            Text {
                width: parent.width
                text: dlg.origin === "ai"
                      ? "NEXUS AI lo propone" + (dlg.reason ? ": «" + dlg.reason + "»" : "") + ". No pasará nada si no lo confirmas."
                      : (dlg.action === "lock" ? "Necesitarás tu contraseña para volver." : "Las apps abiertas se cerrarán.")
                color: Theme.dim; font.family: Theme.font; font.pixelSize: 14
                wrapMode: Text.Wrap; lineHeight: 1.2
            }
            Item { width: 1; height: 4 }
            Row {
                anchors.right: parent.right
                spacing: 10
                Button {
                    id: cancelBtn
                    text: "Cancelar"
                    font.family: Theme.font; font.pixelSize: 14
                    onClicked: dlg.finish(false)
                    Keys.onReturnPressed: dlg.finish(false)
                    Keys.onEscapePressed: dlg.finish(false)
                    contentItem: Text { text: cancelBtn.text; font: cancelBtn.font; color: Theme.text; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                    background: Rectangle { implicitWidth: 112; implicitHeight: 40; radius: 12; color: cancelBtn.down ? Theme.alpha(Theme.text, 0.16) : cancelBtn.hovered ? Theme.alpha(Theme.text, 0.10) : Theme.card2; border.color: cancelBtn.activeFocus ? Theme.accent : Theme.border; border.width: cancelBtn.activeFocus ? 2 : 1 }
                }
                Button {
                    id: okBtn
                    text: (dlg.texts[dlg.action] || ["", "Aceptar"])[1]
                    font.family: Theme.font; font.pixelSize: 14; font.weight: Font.DemiBold
                    onClicked: dlg.finish(true)
                    Keys.onEscapePressed: dlg.finish(false)
                    contentItem: Text { text: okBtn.text; font: okBtn.font; color: "#ffffff"; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                    background: Rectangle { implicitWidth: 128; implicitHeight: 40; radius: 12; color: dlg.destructive ? (okBtn.down ? "#d9415e" : "#ff5c7a") : (okBtn.down ? Qt.darker(Theme.accent, 1.2) : Theme.accent); border.color: okBtn.activeFocus ? "#ffffff" : "transparent"; border.width: 2 }
                }
            }
        }
    }
}
