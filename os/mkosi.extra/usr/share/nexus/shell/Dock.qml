import QtQuick
import QtQuick.Window
import org.kde.layershell 1.0 as LayerShell

Window {
    id: dock
    visible: Session.layout === "clasico"            // the "barra" desktop has Taskbar.qml instead
    color: "transparent"
    width: pill.width + 24
    height: 140                                   // pill + room above it for the hover lift and the name tooltip
    LayerShell.Window.scope: "nexus-dock"
    LayerShell.Window.layer: LayerShell.Window.LayerTop
    LayerShell.Window.anchors: LayerShell.Window.AnchorBottom
    LayerShell.Window.exclusionZone: 112          // windows stop above the pill (bottom margin 16 + height 92 + 4)
    LayerShell.Window.keyboardInteractivity: LayerShell.Window.KeyboardInteractivityNone

    readonly property var order: ["files", "browser", "editor", "code", "terminal", "agents", "automations", "connect", "monitor", "settings"]
        .filter(function(id) { return id !== "code" || !!Session.apps.code })   // VS Code only while installed

    Rectangle {
        id: pill
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.bottom: parent.bottom
        anchors.bottomMargin: 16
        height: 92
        width: row.width + 28
        radius: 28
        color: Theme.panel
        border.color: Theme.dark ? Qt.rgba(1, 1, 1, 0.12) : Theme.border
        Row {
            id: row
            anchors.centerIn: parent
            spacing: 8
            DockItem {
                icon: Qt.resolvedUrl("../icons/nexus-tile.svg")
                label: "NEXUS AI"
                launches: false
                onClicked: Session.openPanel("ai")
            }
            Rectangle { width: 1; height: 50; color: Theme.border; anchors.verticalCenter: parent.verticalCenter }
            Repeater {
                model: dock.order
                DockItem {
                    required property string modelData
                    icon: Qt.resolvedUrl("../icons/app-" + modelData + ".svg")
                    label: (Session.apps[modelData] || {}).name || modelData
                    running: !!(Session.apps[modelData] || {}).running
                    onClicked: Session.launch(modelData)
                }
            }
        }
    }
}
