import QtQuick
import QtQuick.Controls
import "../shell"

// Ajustes → Buscador: where NEXUS Search gets its web results. With a key of a search service (Tavily or Brave
// Search, both with a free monthly allowance) the results are there in under a second and NEXUS AI only writes the
// short answer; without one, Claude does the whole search (seconds, and a few cents). The key is tried with one real
// search before it is kept, stays in this computer and is never shown again.
Item {
    id: page
    property var info: null            // GET /search/provider
    property string pick: "tavily"
    property string msg: ""
    property bool bad: false
    property bool busy: false
    readonly property var chosen: { var l = info ? info.providers : []; for (var i = 0; i < l.length; i++) if (l[i].id === pick) return l[i]; return null }
    readonly property string activeName: { var l = info ? info.providers : []; for (var i = 0; i < l.length; i++) if (info.provider === l[i].id) return l[i].name; return "" }

    function load() { Session.request("GET", "/search/provider", null, function(st, j) { if (st === 200 && j) { page.info = j; if (j.provider) page.pick = j.provider } }) }
    function save() {
        if (busy || keyField.text.trim() === "") return
        busy = true; msg = ""
        Session.request("POST", "/search/provider", { provider: pick, key: keyField.text.trim() }, function(st, j) {
            page.busy = false
            if (st === 200 && j) { page.info = j; keyField.text = ""; page.bad = false; page.msg = "Clave comprobada con una búsqueda real y guardada. Los resultados ya son instantáneos." }
            else { page.bad = true; page.msg = j && j.error ? j.error : "No se ha podido comprobar la clave." }
        })
    }
    function removeKey() { Session.request("DELETE", "/search/provider", null, function(st, j) { if (st === 200 && j) { page.info = j; page.bad = false; page.msg = "Clave quitada." } }) }
    onVisibleChanged: if (visible) load()
    Component.onCompleted: if (visible) load()

    component Pill: Rectangle {
        id: pl
        property string label: ""
        property bool on: false
        signal clicked()
        width: plText.implicitWidth + 26; height: 32; radius: 16
        color: on ? Theme.accent : plArea.containsMouse ? Theme.hover : Theme.card2
        Behavior on color { ColorAnimation { duration: Theme.ms(140) } }
        Text { id: plText; anchors.centerIn: parent; text: pl.label; color: pl.on ? "#ffffff" : Theme.dim; font.family: Theme.font; font.pixelSize: 13; font.weight: pl.on ? Font.DemiBold : Font.Normal }
        MouseArea { id: plArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: pl.clicked() }
    }
    component Btn: Rectangle {
        id: bt
        property string label: ""
        property bool primary: false
        property color tint: Theme.accent
        signal clicked()
        width: btText.implicitWidth + 28; height: 36; radius: 11
        opacity: enabled ? 1 : 0.5
        color: primary ? (btArea.pressed ? Qt.darker(tint, 1.2) : tint) : btArea.containsMouse ? Theme.alpha(tint, 0.16) : Theme.alpha(tint, 0.10)
        Text { id: btText; anchors.centerIn: parent; text: bt.label; color: bt.primary ? "#ffffff" : bt.tint; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
        MouseArea { id: btArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: bt.clicked() }
    }

    Flickable {
        anchors.fill: parent
        contentWidth: width; contentHeight: col.height + 28
        clip: true; boundsBehavior: Flickable.StopAtBounds
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
        Column {
            id: col
            width: Math.min(parent.width - 14, 700)
            spacing: 14
            Text { text: "Buscador"; color: Theme.text; font.family: Theme.font; font.pixelSize: 24; font.weight: Font.DemiBold }

            // ---------------- how fast it is now
            Rectangle {
                width: parent.width; height: stateCol.height + 32; radius: 18
                readonly property bool fast: page.info !== null && page.info.provider !== null
                border.color: Theme.alpha(fast ? Theme.good : Theme.warn, 0.35)
                gradient: Gradient { orientation: Gradient.Horizontal
                    GradientStop { position: 0; color: Theme.alpha(parent.fast ? Theme.good : Theme.warn, 0.16) }
                    GradientStop { position: 0.8; color: Theme.card } }
                Rectangle { x: 18; y: 18; width: 38; height: 38; radius: 11; color: Theme.alpha(parent.fast ? Theme.good : Theme.warn, 0.18)
                    LineIcon { anchors.centerIn: parent; name: parent.parent.fast ? "bolt" : "clock"; color: parent.parent.fast ? Theme.good : Theme.warn; size: 20 } }
                Column {
                    id: stateCol
                    x: 70; y: 16; width: parent.width - 88; spacing: 3
                    Text { width: parent.width; wrapMode: Text.Wrap; text: !page.info ? "Comprobando…" : parent.parent.fast ? "Resultados al instante con " + page.activeName : "Ahora mismo cada búsqueda tarda unos segundos"
                        color: Theme.text; font.family: Theme.font; font.pixelSize: 17; font.weight: Font.DemiBold }
                    Text { width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.2
                        text: parent.parent.fast ? "La lista de resultados llega en menos de un segundo y NEXUS AI solo escribe el resumen, a partir de ella."
                                                 : "Sin un servicio de búsqueda, toda la búsqueda la hace Claude: unos 8 segundos y entre 1 y 3 céntimos cada vez. Con una clave gratuita, la lista sale al instante."
                        color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                }
            }

            // ---------------- the search service and its key
            Text { text: "SERVICIO DE BÚSQUEDA"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold; font.letterSpacing: 1; leftPadding: 4; topPadding: 6 }
            Rectangle {
                width: parent.width; height: provCol.height + 36; radius: 16; color: Theme.card; border.color: Theme.border
                Column {
                    id: provCol
                    x: 18; y: 18; width: parent.width - 36; spacing: 12
                    Row {
                        spacing: 8
                        Repeater {
                            model: page.info ? page.info.providers : []
                            Pill { required property var modelData; label: modelData.name + (page.info.provider === modelData.id ? "  ✓" : ""); on: page.pick === modelData.id; onClicked: { page.pick = modelData.id; page.msg = "" } }
                        }
                    }
                    Text { visible: page.chosen !== null; width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.2
                        text: page.chosen ? page.chosen.free.charAt(0).toUpperCase() + page.chosen.free.slice(1) + ". La clave se consigue en " + String(page.chosen.signup).replace("https://", "") + " (créala allí, cópiala y pégala aquí)." : ""
                        color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                    TextField {
                        id: keyField
                        width: parent.width
                        placeholderText: page.info && page.info.provider === page.pick ? "Hay una clave guardada. Pega otra para cambiarla" : "Pega aquí la clave"
                        echoMode: TextInput.Password
                        color: Theme.text; placeholderTextColor: Theme.faint
                        font.family: Theme.mono; font.pixelSize: 14; leftPadding: 14
                        background: Rectangle { implicitHeight: 42; radius: 12; color: Theme.card2; border.color: keyField.activeFocus ? Theme.accent : Theme.border; border.width: keyField.activeFocus ? 2 : 1 }
                        onAccepted: page.save()
                    }
                    Row {
                        spacing: 10
                        Btn { label: page.busy ? "Probando la clave…" : "Probar y guardar"; primary: true; enabled: !page.busy && keyField.text.trim() !== ""; onClicked: page.save() }
                        Btn { label: "Quitar la clave"; tint: Theme.danger; visible: page.info !== null && page.info.provider !== null; onClicked: page.removeKey() }
                    }
                    Text { visible: page.msg !== ""; width: parent.width; wrapMode: Text.Wrap; text: page.msg; color: page.bad ? Theme.danger : Theme.good; font.family: Theme.font; font.pixelSize: 13 }
                    Text { width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.2
                        text: "La clave se guarda solo en este equipo, viaja únicamente a ese servicio y no se vuelve a mostrar. Lo que buscas se envía a ese servicio para darte los resultados."
                        color: Theme.faint; font.family: Theme.font; font.pixelSize: 12 }
                }
            }

            // ---------------- NEXUS AI's answer
            Text { text: "RESPUESTA DE NEXUS AI"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold; font.letterSpacing: 1; leftPadding: 4; topPadding: 6 }
            Rectangle {
                width: parent.width; height: aiCol.height + 36; radius: 16; color: Theme.card; border.color: Theme.border
                Column {
                    id: aiCol
                    x: 18; y: 18; width: parent.width - 36; spacing: 10
                    Row {
                        spacing: 8
                        Repeater {
                            model: [["auto", "En cada búsqueda"], ["manual", "Al pulsar"], ["off", "Nunca (sin web)"]]
                            Pill { required property var modelData; label: modelData[1]; on: (Session.prefs.searchWeb || "auto") === modelData[0]; onClicked: Session.setPref("searchWeb", modelData[0]) }
                        }
                    }
                    Text { width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.2
                        text: "Un párrafo corto encima de los resultados, con las fuentes numeradas. Lo escribe Claude con tu clave (menos de 1 céntimo con un servicio de búsqueda). «Nunca» deja NEXUS Search solo con lo de tu equipo y la calculadora."
                        color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                }
            }
            Item { width: 1; height: 4 }
        }
    }
}
