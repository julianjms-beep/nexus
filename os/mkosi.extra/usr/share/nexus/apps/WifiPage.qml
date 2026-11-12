import QtQuick
import "../shell"

// Ajustes → Wi-Fi: on/off, the network in use, the networks around (click to join, a password typed in the row),
// the saved ones (forget), the cable. nexus-sessiond talks to NetworkManager (core/src/devices.ts).
Item {
    id: page
    property var st: null          // GET /devices → wifi
    property var list: null        // GET /devices/wifi
    property bool scanning: false
    property string err: ""
    property string asking: ""     // the network whose password is being typed
    property string joining: ""
    function load(rescan) {
        Session.request("GET", "/devices", null, function(s, j) { if (s === 200 && j) page.st = j.wifi })
        if (rescan) scanning = true
        Session.request("GET", "/devices/wifi" + (rescan ? "?rescan=1" : ""), null, function(s, j) { page.scanning = false; if (s === 200 && j) { page.list = j; page.err = "" } else page.err = j && j.error ? j.error : "" })
    }
    function post(p, b, cb) { Session.request("POST", p, b, function(s, j) { if (s !== 200) page.err = j && j.error ? j.error : "No se ha podido hacer el cambio."; else page.err = ""; if (cb) cb(s, j); page.load(false) }) }
    function join(net, pw) { joining = net.ssid; asking = ""; post("/devices/wifi/connect", pw ? { ssid: net.ssid, password: pw } : { ssid: net.ssid }, function(s, j) { page.joining = ""; if (s === 401) page.asking = net.ssid }) }
    readonly property var nets: list && list.networks ? list.networks : []
    readonly property var cur: st && st.current ? st.current : null
    readonly property var others: nets.filter(function(n) { return !n.current })
    Timer { interval: 20000; running: page.visible; repeat: true; onTriggered: page.load(false) }
    onVisibleChanged: if (visible) load(true)
    Component.onCompleted: load(true)

    Flickable {
        anchors.fill: parent; contentWidth: width; contentHeight: col.height + 20; clip: true; boundsBehavior: Flickable.StopAtBounds
        Column {
            id: col
            width: parent.width - 14; spacing: 14
            Text { text: "Wi-Fi"; color: Theme.text; font.family: Theme.font; font.pixelSize: 26; font.weight: Font.Bold }
            Text { visible: page.err !== ""; width: parent.width; wrapMode: Text.Wrap; text: page.err; color: Theme.danger; font.family: Theme.font; font.pixelSize: 13 }
            SettingsCard {
                Item {
                    width: parent.width; height: 44
                    Column {
                        anchors.verticalCenter: parent.verticalCenter
                        Text { text: "Wi-Fi"; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.DemiBold }
                        Text { text: !page.st ? "Comprobando…" : !page.st.available ? "Este equipo no tiene gestor de red" : !page.st.hardware ? "Este equipo no tiene tarjeta Wi-Fi" : page.st.on ? (page.cur ? "Conectado a " + page.cur.ssid : "Encendido, sin conectar") : "Apagado"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                    }
                    NexusSwitch { anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; checked: !!(page.st && page.st.on); enabled: !!(page.st && page.st.hardware); onToggled: page.post("/devices/wifi", { on: checked }) }
                }
                Item {
                    visible: !!(page.st && page.st.ethernet)
                    width: parent.width; height: 36
                    LineIcon { anchors.verticalCenter: parent.verticalCenter; name: "ethernet"; size: 18; color: Theme.dim }
                    Text { x: 28; anchors.verticalCenter: parent.verticalCenter; text: page.st && page.st.ethernet ? (page.st.ethernet.connected ? "Cable conectado · " + page.st.ethernet.address : "Cable sin conexión") : ""; color: Theme.text; font.family: Theme.font; font.pixelSize: 13 }
                }
            }
            SettingsCard {
                visible: !!page.cur
                title: "Red en uso"
                Item {
                    width: parent.width; height: 44
                    WifiGlyph { anchors.verticalCenter: parent.verticalCenter; online: true; color: Theme.accent }
                    Column {
                        x: 30; anchors.verticalCenter: parent.verticalCenter
                        Text { text: page.cur ? page.cur.ssid : ""; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.DemiBold }
                        Text { text: page.cur ? (page.cur.secure ? "Protegida · " : "Abierta · ") + "señal " + page.cur.signal + " %" : ""; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                    }
                    Row {
                        anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; spacing: 8
                        SettingsButton { label: "Desconectar"; onClicked: page.post("/devices/wifi/disconnect", {}) }
                        SettingsButton { label: "Olvidar"; danger: true; onClicked: page.post("/devices/wifi/forget", { ssid: page.cur.ssid }) }
                    }
                }
            }
            SettingsCard {
                visible: !!(page.st && page.st.on && page.st.hardware)
                title: page.scanning ? "Buscando redes…" : "Redes"
                note: page.others.length === 0 && !page.scanning ? "No se ve ninguna red cerca." : ""
                Repeater {
                    model: page.others
                    Item {
                        required property var modelData
                        width: parent.width; height: page.asking === modelData.ssid ? 90 : 44
                        Rectangle { anchors.fill: parent; radius: 10; color: nma.containsMouse ? Theme.hover : "transparent" }
                        WifiGlyph { y: 12; online: true; color: modelData.bars >= 2 ? Theme.text : Theme.dim }
                        Column {
                            x: 30; y: 6
                            Text { text: modelData.ssid; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: modelData.known ? Font.DemiBold : Font.Normal }
                            Text { text: (modelData.known ? "Guardada · " : "") + (modelData.secure ? "Con contraseña" : "Abierta") + " · " + modelData.signal + " %"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 11 }
                        }
                        Text { visible: page.joining === modelData.ssid; anchors.right: parent.right; anchors.rightMargin: 100; y: 14; text: "Conectando…"; color: Theme.accent; font.family: Theme.font; font.pixelSize: 12 }
                        Row {
                            anchors.right: parent.right; y: 8; spacing: 6
                            SettingsButton { visible: modelData.known; label: "Olvidar"; danger: true; onClicked: page.post("/devices/wifi/forget", { ssid: modelData.ssid }) }
                            SettingsButton { label: "Conectar"; primary: true; onClicked: modelData.secure && !modelData.known ? page.asking = modelData.ssid : page.join(modelData, "") }
                        }
                        MouseArea { id: nma; anchors.fill: parent; hoverEnabled: true; z: -1 }
                        // the password, typed in the row
                        Rectangle {
                            visible: page.asking === modelData.ssid
                            x: 30; y: 50; width: parent.width - 30; height: 32; radius: 8
                            color: Theme.card2; border.color: pwIn.activeFocus ? Theme.alpha(Theme.accent, 0.7) : Theme.border
                            TextInput {
                                id: pwIn
                                x: 10; width: parent.width - 110; anchors.verticalCenter: parent.verticalCenter
                                echoMode: TextInput.Password; color: Theme.text; font.family: Theme.font; font.pixelSize: 13
                                onVisibleChanged: if (visible) { text = ""; forceActiveFocus() }
                                Keys.onReturnPressed: page.join(modelData, text)
                                Keys.onEscapePressed: page.asking = ""
                            }
                            Text { visible: pwIn.text === ""; x: 10; anchors.verticalCenter: parent.verticalCenter; text: "Contraseña de la red"; color: Theme.faint; font.family: Theme.font; font.pixelSize: 13 }
                            SettingsButton { anchors.right: parent.right; anchors.rightMargin: 4; anchors.verticalCenter: parent.verticalCenter; label: "Entrar"; primary: true; small: true; onClicked: page.join(modelData, pwIn.text) }
                        }
                    }
                }
                SettingsButton { label: page.scanning ? "Buscando…" : "Buscar otra vez"; onClicked: page.load(true) }
            }
        }
    }
}
