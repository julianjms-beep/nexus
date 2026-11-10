import QtQuick
import QtQuick.Window
import QtQuick.Controls
import QtCore
import Qt.labs.folderlistmodel
import "../shell"

// Notas: plain-text notes in ~/Notas, saved automatically.
Window {
    id: w
    visible: true
    width: 920; height: 620
    minimumWidth: 640; minimumHeight: 420
    title: "Notas"
    color: Theme.bg

    readonly property url dir: String(StandardPaths.writableLocation(StandardPaths.HomeLocation)) + "/Notas"
    property url current: ""
    property bool loading: false
    property string status: ""

    function load(url) {
        save()
        current = url; loading = true
        var x = new XMLHttpRequest()
        x.onreadystatechange = function() { if (x.readyState === XMLHttpRequest.DONE) { editor.text = x.responseText || ""; w.loading = false; w.status = "" } }
        x.open("GET", String(url)); x.send()
    }
    function save() {
        if (!String(current) || loading || !dirty) return
        var x = new XMLHttpRequest()
        x.onreadystatechange = function() { if (x.readyState === XMLHttpRequest.DONE) w.status = "Guardado" }
        x.open("PUT", String(current)); x.send(editor.text)
        dirty = false
    }
    property bool dirty: false
    function newNote() {
        var n = 1
        while (true) { var found = false; for (var i = 0; i < notes.count; i++) if (notes.get(i, "fileName") === "Nota " + n + ".txt") found = true; if (!found) break; n++ }
        var url = String(dir) + "/Nota " + n + ".txt"
        var x = new XMLHttpRequest()
        x.onreadystatechange = function() { if (x.readyState === XMLHttpRequest.DONE) { w.current = url; editor.text = ""; editor.forceActiveFocus() } }
        x.open("PUT", url); x.send("")
    }
    Timer { id: autosave; interval: 700; onTriggered: w.save() }
    onClosing: save()

    FolderListModel {
        id: notes
        folder: w.dir
        nameFilters: ["*.txt", "*.md"]
        showDirs: false
        sortField: FolderListModel.Time
        onStatusChanged: if (status === FolderListModel.Ready && !String(w.current) && count > 0) w.load(get(0, "fileUrl"))
    }

    Rectangle {
        id: side
        width: 250; height: parent.height
        color: Theme.card
        Rectangle { anchors.right: parent.right; width: 1; height: parent.height; color: Theme.border }
        Text { x: 18; y: 18; text: "Notas"; color: Theme.text; font.family: Theme.font; font.pixelSize: 20; font.weight: Font.DemiBold }
        BarButton { anchors.right: parent.right; anchors.rightMargin: 12; y: 16; onClicked: w.newNote(); Text { text: "+  Nueva"; color: Theme.accent; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold } }
        ListView {
            anchors.top: parent.top; anchors.topMargin: 58
            anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom
            anchors.margins: 8
            clip: true; spacing: 2
            model: notes
            delegate: Rectangle {
                required property string fileName
                required property url fileUrl
                required property date fileModified
                width: ListView.view.width; height: 54; radius: 10
                color: String(w.current) === String(fileUrl) ? Theme.alpha(Theme.accent, 0.18) : na.containsMouse ? Theme.hover : "transparent"
                Text { x: 12; y: 9; width: parent.width - 24; elide: Text.ElideRight; text: fileName.replace(/\.(txt|md)$/, ""); color: Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.DemiBold }
                Text { x: 12; y: 30; text: fileModified.toLocaleString(Qt.locale("es_ES"), "d MMM, HH:mm"); color: Theme.faint; font.family: Theme.font; font.pixelSize: 11 }
                MouseArea { id: na; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: w.load(fileUrl) }
            }
        }
    }

    ScrollView {
        anchors.left: side.right; anchors.right: parent.right; anchors.top: parent.top; anchors.bottom: footer.top
        anchors.margins: 24
        TextArea {
            id: editor
            placeholderText: String(w.current) ? "Escribe…" : "Crea una nota con «+ Nueva»"
            placeholderTextColor: Theme.faint
            enabled: String(w.current) !== ""
            wrapMode: Text.Wrap
            color: Theme.text
            selectionColor: Theme.alpha(Theme.accent, 0.4)
            font.family: Theme.font; font.pixelSize: 16
            background: null
            onTextChanged: if (!w.loading) { w.dirty = true; w.status = "…"; autosave.restart() }
        }
    }
    Text {
        id: footer
        anchors.right: parent.right; anchors.bottom: parent.bottom; anchors.margins: 14
        text: w.status
        color: Theme.faint; font.family: Theme.font; font.pixelSize: 11
    }
}
