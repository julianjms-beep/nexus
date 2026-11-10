import QtQuick
import QtQuick.Window
import org.kde.layershell 1.0 as LayerShell

Window {
    id: bar
    visible: Session.layout === "clasico"   // the "barra" desktop has Taskbar.qml at the bottom instead
    height: 58                     // a floating glass bar: 8 px above, 44 px bar, 6 px below
    color: "transparent"
    LayerShell.Window.scope: "nexus-bar"
    LayerShell.Window.layer: LayerShell.Window.LayerTop
    LayerShell.Window.anchors: LayerShell.Window.AnchorTop | LayerShell.Window.AnchorLeft | LayerShell.Window.AnchorRight
    LayerShell.Window.exclusionZone: 58
    LayerShell.Window.keyboardInteractivity: LayerShell.Window.KeyboardInteractivityNone

    function pct(v) { return (v === null || v === undefined) ? "–" : Math.round(v) + "%" }
    readonly property var sys: Session.system

    Rectangle {
        id: bg
        x: 10; y: 8
        width: parent.width - 20; height: 44
        radius: 16
        color: Theme.panel
        border.color: Theme.dark ? Qt.rgba(1, 1, 1, 0.11) : Theme.border
    }

    Row {
        anchors.left: bg.left; anchors.leftMargin: 6
        anchors.verticalCenter: bg.verticalCenter
        spacing: 2
        BarButton {
            onClicked: Session.openPanel("ai")
            Row {
                spacing: 8
                NexusMark { width: 20; height: 20; anchors.verticalCenter: parent.verticalCenter }
                Text { anchors.verticalCenter: parent.verticalCenter; text: "NEXUS"; color: Theme.text; font.family: Theme.font; font.pixelSize: 15; font.weight: Font.Bold; font.letterSpacing: 2.5 }
            }
        }
        Rectangle { width: 1; height: 20; color: Theme.border; anchors.verticalCenter: parent.verticalCenter }
        BarButton {
            onClicked: Session.openPanel("ai")
            Row {
                spacing: 8
                Text { anchors.verticalCenter: parent.verticalCenter; text: "Pregunta a NEXUS AI"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 15 }
            }
        }
    }

    Text {
        anchors.centerIn: bg
        text: { var d = Session.now.toLocaleDateString(Qt.locale("es_ES"), "ddd d MMM"); return d + "    " + Qt.formatTime(Session.now, Session.clock24 ? "HH:mm" : "h:mm AP") }
        color: Theme.text
        font.family: Theme.font; font.pixelSize: 15; font.weight: Font.DemiBold
    }

    Row {
        anchors.right: bg.right; anchors.rightMargin: 6
        anchors.verticalCenter: bg.verticalCenter
        spacing: 2
        BarButton {
            onClicked: Session.launch("settings")
            Row {
                spacing: 7
                Rectangle {
                    anchors.verticalCenter: parent.verticalCenter
                    width: 8; height: 8; radius: 4
                    color: !Session.engineUp ? Theme.danger : Session.aiConfigured ? Theme.good : Theme.warn
                }
                Text { anchors.verticalCenter: parent.verticalCenter; text: "IA"; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.DemiBold }
            }
        }
        Rectangle { width: 1; height: 20; color: Theme.border; anchors.verticalCenter: parent.verticalCenter }
        BarButton {
            onClicked: Session.launch("monitor")
            Row {
                spacing: 12
                Text { text: "CPU " + bar.pct(bar.sys && bar.sys.cpu ? bar.sys.cpu.usagePercent : null); color: Theme.dim; font.family: Theme.font; font.pixelSize: 14 }
                Text { text: "RAM " + bar.pct(bar.sys && bar.sys.memory ? bar.sys.memory.usedPercent : null); color: Theme.dim; font.family: Theme.font; font.pixelSize: 14 }
            }
        }
        Rectangle { width: 1; height: 20; color: Theme.border; anchors.verticalCenter: parent.verticalCenter }
        BarButton {
            onClicked: Session.openPanel("quick")
            Row {
                spacing: 8
                LineIcon { visible: Session.prefs.dnd === true; anchors.verticalCenter: parent.verticalCenter; name: "bell-off"; size: 16; color: Theme.dim }
                Text {
                    visible: !!(bar.sys && bar.sys.battery)
                    anchors.verticalCenter: parent.verticalCenter
                    text: bar.sys && bar.sys.battery ? bar.sys.battery.percent + "%" : ""
                    color: bar.sys && bar.sys.battery && bar.sys.battery.percent <= 15 && bar.sys.battery.status !== "Charging" ? Theme.warn : Theme.dim
                    font.family: Theme.font; font.pixelSize: 14
                }
                WifiGlyph {
                    anchors.verticalCenter: parent.verticalCenter
                    online: !!(bar.sys && bar.sys.online)
                    color: online ? Theme.text : Theme.warn
                }
                Text {      // words only when something is wrong
                    visible: !(bar.sys && bar.sys.online)
                    anchors.verticalCenter: parent.verticalCenter
                    text: "Sin red"; color: Theme.warn
                    font.family: Theme.font; font.pixelSize: 14
                }
            }
        }
        Rectangle { width: 1; height: 20; color: Theme.border; anchors.verticalCenter: parent.verticalCenter }
        BarButton {
            onClicked: Session.openPanel("power")
            PowerGlyph { color: Theme.text; width: 16; height: 16 }
        }
    }
}
