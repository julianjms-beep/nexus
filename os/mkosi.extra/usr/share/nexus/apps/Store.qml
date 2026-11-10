import QtQuick
import QtQuick.Window
import QtQuick.Controls
import "../shell"

// NEXUS Store: the services you use on the web, as apps of their own (core/src/store.ts). "Instalar" adds the app
// to this computer (one line of settings: nothing is downloaded); "Abrir" starts it in its own window with its own
// session. "Añadir una web" turns any https:// address into an app.
Window {
    id: w
    visible: true
    width: 1040; height: 700
    minimumWidth: 640; minimumHeight: 460
    title: "NEXUS Store"
    color: Theme.bg

    property var store: null
    property string cat: "Todas"
    property string filter: ""
    property bool adding: false
    property string addMsg: ""
    property string confirmRemove: ""
    readonly property var cats: ["Todas", "Instaladas"].concat(store ? store.categories : [])
    readonly property var shown: {
        var l = store ? store.apps : [], f = filter.toLowerCase().trim(), out = []
        for (var i = 0; i < l.length; i++) {
            var a = l[i]
            if (cat === "Instaladas" && !a.installed) continue
            if (cat !== "Todas" && cat !== "Instaladas" && a.category !== cat) continue
            if (f && (a.name + " " + a.about + " " + a.host).toLowerCase().indexOf(f) < 0) continue
            out.push(a)
        }
        return out
    }
    function load() { Session.request("GET", "/store", null, function(st, j) { if (st === 200 && j) w.store = j }) }
    function act(path, body, done) { Session.request("POST", path, body, function(st, j) { if (st === 200 && j && j.apps) w.store = j; if (done) done(st, j) }) }
    Component.onCompleted: load()

    component Btn: Rectangle {
        id: bt
        property string label: ""
        property bool primary: false
        property color tint: Theme.accent
        signal clicked()
        width: btText.implicitWidth + 26; height: 32; radius: 16
        opacity: enabled ? 1 : 0.5
        color: primary ? (btArea.pressed ? Qt.darker(tint, 1.2) : tint) : btArea.containsMouse ? Theme.alpha(tint, 0.18) : Theme.alpha(tint, 0.10)
        Behavior on color { ColorAnimation { duration: Theme.ms(120) } }
        Text { id: btText; anchors.centerIn: parent; text: bt.label; color: bt.primary ? "#ffffff" : bt.tint; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
        MouseArea { id: btArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: bt.clicked() }
    }
    component Field: TextField {
        id: fd
        color: Theme.text; placeholderTextColor: Theme.faint
        font.family: Theme.font; font.pixelSize: 14; leftPadding: 14
        background: Rectangle { implicitHeight: 40; radius: 12; color: Theme.card2; border.color: fd.activeFocus ? Theme.accent : Theme.border; border.width: fd.activeFocus ? 2 : 1 }
    }

    // ---------------- categories
    Rectangle {
        id: side
        width: 210; height: parent.height
        color: Theme.card
        Rectangle { anchors.right: parent.right; width: 1; height: parent.height; color: Theme.border }
        Column {
            x: 12; y: 18; width: parent.width - 24; spacing: 4
            Row {
                spacing: 10; bottomPadding: 12; leftPadding: 6
                AppIcon { app: "store"; width: 30; height: 30 }
                Text { text: "Store"; color: Theme.text; font.family: Theme.font; font.pixelSize: 20; font.weight: Font.DemiBold; anchors.verticalCenter: parent.verticalCenter }
            }
            Repeater {
                model: w.cats
                Rectangle {
                    required property string modelData
                    readonly property bool on: w.cat === modelData
                    width: parent.width; height: 36; radius: 10
                    color: on ? Theme.alpha(Theme.accent, 0.18) : ca.containsMouse ? Theme.hover : "transparent"
                    Behavior on color { ColorAnimation { duration: Theme.ms(140) } }
                    Text { x: 12; anchors.verticalCenter: parent.verticalCenter; text: modelData; color: on ? Theme.text : Theme.dim; font.family: Theme.font; font.pixelSize: 14; font.weight: on ? Font.DemiBold : Font.Normal }
                    Text { visible: modelData === "Instaladas" && w.store !== null && w.store.installed > 0; anchors.right: parent.right; anchors.rightMargin: 12; anchors.verticalCenter: parent.verticalCenter
                           text: w.store ? w.store.installed : ""; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                    MouseArea { id: ca; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: w.cat = modelData }
                }
            }
        }
        Text {
            x: 18; width: parent.width - 36; anchors.bottom: parent.bottom; anchors.bottomMargin: 16; wrapMode: Text.Wrap; lineHeight: 1.2
            text: "Cada app abre en su ventana, con su propia sesión, aparte del Navegador y de las demás."
            color: Theme.faint; font.family: Theme.font; font.pixelSize: 12
        }
    }

    // ---------------- the apps
    Item {
        anchors.left: side.right; anchors.right: parent.right; anchors.top: parent.top; anchors.bottom: parent.bottom
        anchors.margins: 24
        Row {
            id: top
            width: parent.width; spacing: 12
            Field { id: find; width: parent.width - addBtn.width - 12; placeholderText: "Buscar una app"; onTextChanged: w.filter = text }
            Btn { id: addBtn; height: 40; radius: 12; label: "＋ Añadir una web"; onClicked: { w.adding = !w.adding; w.addMsg = ""; if (w.adding) addName.forceActiveFocus() } }
        }
        // any https:// address as an app
        Rectangle {
            id: addBox
            anchors.top: top.bottom; anchors.topMargin: w.adding ? 12 : 0
            width: parent.width; height: w.adding ? addCol.height + 28 : 0
            visible: height > 0; clip: true
            radius: 16; color: Theme.card; border.color: Theme.border
            Behavior on height { NumberAnimation { duration: Theme.ms(200); easing.type: Easing.OutCubic } }
            Column {
                id: addCol
                x: 16; y: 14; width: parent.width - 32; spacing: 10
                Text { text: "Convierte cualquier web en una app"; color: Theme.text; font.family: Theme.font; font.pixelSize: 15; font.weight: Font.DemiBold }
                Row {
                    width: parent.width; spacing: 10
                    Field { id: addName; width: (parent.width - 20 - addGo.width) * 0.36; placeholderText: "Nombre"; onAccepted: addUrl.forceActiveFocus() }
                    Field { id: addUrl; width: (parent.width - 20 - addGo.width) * 0.64; placeholderText: "Dirección (app.ejemplo.com)"; onAccepted: addGo.clicked() }
                    Btn {
                        id: addGo; height: 40; radius: 12; label: "Añadir"; primary: true
                        enabled: addName.text.trim() !== "" && addUrl.text.trim() !== ""
                        onClicked: w.act("/store/add", { name: addName.text, url: addUrl.text }, function(st, j) {
                            if (st === 200) { addName.text = ""; addUrl.text = ""; w.adding = false; w.cat = "Instaladas" }
                            else w.addMsg = j && j.error ? j.error : "No se ha podido añadir."
                        })
                    }
                }
                Text { visible: w.addMsg !== ""; text: w.addMsg; color: Theme.danger; font.family: Theme.font; font.pixelSize: 13 }
            }
        }
        Flickable {
            id: flick
            anchors.top: addBox.bottom; anchors.topMargin: 16; anchors.bottom: parent.bottom
            width: parent.width
            contentWidth: width; contentHeight: grid.height + 12
            clip: true; boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
            Flow {
                id: grid
                width: flick.width - 12
                spacing: 14
                readonly property int cols: Math.max(1, Math.floor((width + 14) / 344))
                readonly property real cardW: Math.floor((width - 14 * (cols - 1)) / cols)
                Repeater {
                    model: w.shown
                    Rectangle {
                        id: card
                        required property var modelData
                        width: grid.cardW; height: 150; radius: 18
                        color: Theme.card; border.color: ma.containsMouse ? Theme.alpha(modelData.color, 0.7) : Theme.border
                        Behavior on border.color { ColorAnimation { duration: Theme.ms(140) } }
                        MouseArea { id: ma; anchors.fill: parent; hoverEnabled: true; acceptedButtons: Qt.NoButton }
                        Rectangle {   // the tile: a colour and the first letter (nobody's logo)
                            x: 16; y: 16; width: 52; height: 52; radius: 14
                            gradient: Gradient { GradientStop { position: 0; color: Qt.lighter(card.modelData.color, 1.25) } GradientStop { position: 1; color: card.modelData.color } }
                            Text { anchors.centerIn: parent; text: card.modelData.letter; color: "#ffffff"; font.family: Theme.font; font.pixelSize: 25; font.weight: Font.Bold }
                        }
                        Column {
                            x: 82; y: 17; width: parent.width - 98; spacing: 2
                            Text { width: parent.width; elide: Text.ElideRight; text: card.modelData.name; color: Theme.text; font.family: Theme.font; font.pixelSize: 16; font.weight: Font.DemiBold }
                            Text { width: parent.width; elide: Text.ElideRight; text: card.modelData.host; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12 }
                        }
                        Text {
                            x: 16; y: 78; width: parent.width - 32; height: 34; wrapMode: Text.Wrap; elide: Text.ElideRight; maximumLineCount: 2; lineHeight: 1.15
                            text: card.modelData.about; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12
                        }
                        Row {
                            anchors.right: parent.right; anchors.rightMargin: 14; anchors.bottom: parent.bottom; anchors.bottomMargin: 12; spacing: 8
                            Btn {
                                visible: card.modelData.installed
                                label: w.confirmRemove === card.modelData.id ? "¿Seguro?" : "Quitar"; tint: Theme.danger; height: 28
                                onClicked: {
                                    if (w.confirmRemove !== card.modelData.id) { w.confirmRemove = card.modelData.id; return }
                                    w.confirmRemove = ""; w.act("/store/remove", { id: card.modelData.id })
                                }
                            }
                            Btn {
                                label: card.modelData.installed ? "Abrir" : "Instalar"; primary: true; height: 28
                                tint: card.modelData.installed ? Theme.accent : Theme.good
                                onClicked: card.modelData.installed ? w.act("/store/open", { id: card.modelData.id }) : w.act("/store/install", { id: card.modelData.id })
                            }
                        }
                        Text {
                            visible: card.modelData.installed
                            x: 16; anchors.bottom: parent.bottom; anchors.bottomMargin: 18
                            text: "✓ Instalada"; color: Theme.good; font.family: Theme.font; font.pixelSize: 12
                        }
                    }
                }
            }
            Text {
                visible: w.store !== null && w.shown.length === 0
                anchors.horizontalCenter: parent.horizontalCenter; y: 60
                text: w.cat === "Instaladas" && w.filter === "" ? "Aún no has instalado ninguna app. Elige una en «Todas»." : "No hay ninguna app con esas palabras. Puedes añadirla con «Añadir una web»."
                color: Theme.dim; font.family: Theme.font; font.pixelSize: 14
            }
        }
    }
}
