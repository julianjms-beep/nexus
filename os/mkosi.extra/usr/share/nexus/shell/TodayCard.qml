import QtQuick

// Desktop widget "Hoy": the person's tasks (open first, today's finished ones crossed out).
// Tick to finish, × to delete, + asks NEXUS AI ("Apunta …").
Rectangle {
    id: card
    width: 300
    height: col.implicitHeight + 36
    radius: 20
    color: Theme.glass   // glass over the wallpaper
    Behavior on color { ColorAnimation { duration: Theme.ms(500) } }
    border.color: Theme.dark ? Qt.rgba(1, 1, 1, 0.13) : Theme.border

    readonly property var shown: {
        var t = Session.tasks || [], open = [], done = []
        for (var i = 0; i < t.length; i++) (t[i].done ? done : open).push(t[i])
        return open.concat(done).slice(0, 7)
    }
    readonly property int pending: { var n = 0; for (var i = 0; i < (Session.tasks || []).length; i++) if (!Session.tasks[i].done) n++; return n }

    Column {
        id: col
        x: 20; y: 18
        width: parent.width - 40
        spacing: 4

        Item {
            width: parent.width; height: 30
            Text { anchors.verticalCenter: parent.verticalCenter; text: "Hoy"; color: Theme.text; font.family: Theme.font; font.pixelSize: 18; font.weight: Font.DemiBold }
            Text {
                x: 46; anchors.verticalCenter: parent.verticalCenter
                visible: card.pending > 0
                text: card.pending === 1 ? "1 pendiente" : card.pending + " pendientes"
                color: Theme.faint; font.family: Theme.font; font.pixelSize: 12
            }
            Rectangle {
                anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                width: 28; height: 28; radius: 14
                color: addMa.containsMouse ? Theme.alpha(Theme.accent, 0.28) : Theme.alpha(Theme.accent, 0.16)
                Text { anchors.centerIn: parent; anchors.verticalCenterOffset: -1; text: "+"; color: Theme.accent; font.family: Theme.font; font.pixelSize: 20; font.weight: Font.Medium }
                MouseArea { id: addMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: Session.prefill("Apunta ") }
            }
        }
        Item { width: 1; height: 4 }

        Text {
            visible: Session.tasksLoaded && card.shown.length === 0
            width: parent.width
            text: "Nada pendiente. Dile a NEXUS «apunta…»"
            wrapMode: Text.WordWrap
            color: Theme.faint; font.family: Theme.font; font.pixelSize: 13
        }

        Repeater {
            model: card.shown
            delegate: Item {
                id: row
                required property var modelData
                width: col.width; height: Math.max(34, label.implicitHeight + 14)
                Rectangle {
                    id: box
                    width: 20; height: 20; radius: 6
                    anchors.verticalCenter: parent.verticalCenter
                    color: row.modelData.done ? Theme.accent : "transparent"
                    border.color: row.modelData.done ? Theme.accent : Theme.alpha(Theme.text, 0.35)
                    border.width: 1.5
                    Text { anchors.centerIn: parent; visible: row.modelData.done; text: "✓"; color: "#ffffff"; font.pixelSize: 13; font.weight: Font.Bold }
                    MouseArea { anchors.fill: parent; anchors.margins: -6; cursorShape: Qt.PointingHandCursor; onClicked: Session.setTaskDone(row.modelData.id, !row.modelData.done) }
                }
                Text {
                    id: label
                    x: 32; width: parent.width - 32 - 24
                    anchors.verticalCenter: parent.verticalCenter
                    text: row.modelData.text
                    wrapMode: Text.WordWrap; maximumLineCount: 2; elide: Text.ElideRight
                    lineHeight: 1.1
                    color: row.modelData.done ? Theme.faint : Theme.text
                    font.family: Theme.font; font.pixelSize: 14; font.strikeout: row.modelData.done
                }
                Text {
                    anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                    visible: rowMa.containsMouse
                    text: "×"; color: delMa.containsMouse ? Theme.danger : Theme.faint; font.pixelSize: 18
                    MouseArea { id: delMa; anchors.fill: parent; anchors.margins: -6; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: Session.deleteTask(row.modelData.id) }
                }
                MouseArea { id: rowMa; anchors.fill: parent; hoverEnabled: true; acceptedButtons: Qt.NoButton; z: -1 }
            }
        }
    }
}
