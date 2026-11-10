import QtQuick
import QtQuick.Controls

// «Escríbelo con tus palabras»: one box where the person describes what they want, like a prompt. The parent asks
// NEXUS AI for a draft (an automation, an agent or an agency) and opens it in its form: nothing is created here.
// Ctrl+Enter sends. While NEXUS AI works the box shows the seconds that have passed.
Rectangle {
    id: box
    property string title: "Escríbelo con tus palabras"
    property string placeholder: ""
    property string hint: ""
    property string button: "Prepararlo con NEXUS AI"
    property bool busy: false
    property string error: ""
    property alias text: area.text
    property int secs: 0
    signal submit(string text)
    function go() { var t = area.text.trim(); if (!busy && t.length >= 4) box.submit(t) }
    function focusText() { area.forceActiveFocus() }

    implicitWidth: 600
    height: col.implicitHeight + 32
    radius: 16
    color: Theme.alpha(Theme.accent, 0.08)
    border.color: Theme.alpha(Theme.accent, area.activeFocus ? 0.6 : 0.3)
    onBusyChanged: if (busy) secs = 0
    Timer { interval: 1000; repeat: true; running: box.busy; onTriggered: box.secs++ }

    Column {
        id: col
        x: 16; y: 16; width: parent.width - 32
        spacing: 10
        Row {
            spacing: 10
            NexusMark { width: 22; height: 22; anchors.verticalCenter: parent.verticalCenter }
            Text { text: box.title; color: Theme.text; font.family: Theme.font; font.pixelSize: 16; font.weight: Font.DemiBold; anchors.verticalCenter: parent.verticalCenter }
        }
        Rectangle {
            width: parent.width; height: Math.max(88, area.implicitHeight + 16); radius: 12
            color: Theme.card
            border.color: area.activeFocus ? Theme.accent : Theme.border; border.width: area.activeFocus ? 2 : 1
            TextArea {
                id: area
                anchors.fill: parent; anchors.margins: 2
                enabled: !box.busy
                wrapMode: TextEdit.Wrap
                placeholderText: box.placeholder
                placeholderTextColor: Theme.faint
                color: Theme.text
                selectByMouse: true; selectionColor: Theme.alpha(Theme.accent, 0.45); selectedTextColor: Theme.text
                font.family: Theme.font; font.pixelSize: 14
                leftPadding: 12; rightPadding: 12; topPadding: 10; bottomPadding: 10
                background: null
                Keys.onPressed: (e) => {
                    if ((e.key === Qt.Key_Return || e.key === Qt.Key_Enter) && (e.modifiers & Qt.ControlModifier)) { box.go(); e.accepted = true }
                }
            }
        }
        Item {
            width: parent.width; height: Math.max(goBtn.height, hintText.implicitHeight)
            Rectangle {
                id: goBtn
                property bool ready: !box.busy && area.text.trim().length >= 4
                width: goText.implicitWidth + 32; height: 38; radius: 12
                opacity: ready || box.busy ? 1 : 0.5
                color: goArea.pressed ? Qt.darker(Theme.accent, 1.2) : Theme.accent
                Text {
                    id: goText; anchors.centerIn: parent
                    text: box.busy ? "NEXUS AI lo está preparando… " + box.secs + " s" : "✨  " + box.button
                    color: "#ffffff"; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.DemiBold
                }
                MouseArea { id: goArea; anchors.fill: parent; hoverEnabled: true; cursorShape: goBtn.ready ? Qt.PointingHandCursor : Qt.ArrowCursor; onClicked: box.go() }
            }
            Text {
                id: hintText
                anchors.left: goBtn.right; anchors.leftMargin: 14; anchors.right: parent.right; anchors.verticalCenter: goBtn.verticalCenter
                wrapMode: Text.Wrap; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12; lineHeight: 1.15
                text: box.hint
            }
        }
        Text {
            visible: box.error !== ""
            width: parent.width; wrapMode: Text.Wrap
            text: box.error; color: Theme.danger; font.family: Theme.font; font.pixelSize: 13
        }
    }
}
