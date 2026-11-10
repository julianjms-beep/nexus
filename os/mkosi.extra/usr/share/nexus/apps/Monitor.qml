import QtQuick
import QtQuick.Window
import "../shell"

// Monitor: live CPU / memory / disk and the busiest processes.
Window {
    id: w
    visible: true
    width: 900; height: 620
    minimumWidth: 640; minimumHeight: 460
    title: "Monitor"
    color: Theme.bg

    property var sys: Session.system
    property var procs: []
    property var cpuHist: []
    property var memHist: []

    function fmtBytes(b) { if (!b && b !== 0) return "–"; var g = b / 1073741824; return g >= 1 ? g.toFixed(1).replace(".", ",") + " GB" : Math.round(b / 1048576) + " MB" }
    function fmtUptime(s) { if (!s) return "–"; var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + " d " : "") + h + " h " + m + " min" }
    function refresh() {
        Session.request("GET", "/system", null, function(st, j) {
            if (st !== 200 || !j) return
            Session.system = j
            var c = w.cpuHist.slice(-59); c.push(j.cpu.usagePercent === null ? 0 : j.cpu.usagePercent); w.cpuHist = c
            var m = w.memHist.slice(-59); m.push(j.memory.usedPercent); w.memHist = m
            cpuChart.requestPaint(); memChart.requestPaint()
        })
        Session.request("GET", "/processes", null, function(st, j) { if (st === 200 && j) w.procs = j })
    }
    Timer { interval: 2000; running: true; repeat: true; triggeredOnStart: true; onTriggered: w.refresh() }

    component Spark: Canvas {
        property var data: []
        property color line: Theme.accent
        onPaint: {
            var ctx = getContext("2d"); ctx.reset()
            if (!data.length) return
            var n = 60, W = width, H = height
            ctx.beginPath()
            for (var i = 0; i < data.length; i++) {
                var x = W - (data.length - 1 - i) * (W / (n - 1)), y = H - (data[i] / 100) * H
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
            }
            ctx.strokeStyle = line; ctx.lineWidth = 2; ctx.stroke()
            ctx.lineTo(W, H); ctx.lineTo(W - (data.length - 1) * (W / (n - 1)), H); ctx.closePath()
            ctx.fillStyle = Qt.rgba(line.r, line.g, line.b, 0.15); ctx.fill()
        }
    }

    Column {
        anchors.fill: parent
        anchors.margins: 20
        spacing: 16

        Row {
            spacing: 14
            width: parent.width
            Card {
                title: "Procesador"
                width: (parent.width - 28) / 3; height: 150
                Text { text: w.sys && w.sys.cpu.usagePercent !== null ? Math.round(w.sys.cpu.usagePercent) + " %" : "…"; color: Theme.text; font.family: Theme.font; font.pixelSize: 30; font.weight: Font.DemiBold }
                Text { y: 40; text: w.sys ? w.sys.cpu.cores + " núcleos · carga " + w.sys.cpu.load[0] : ""; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                Spark { id: cpuChart; anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom; height: 34; data: w.cpuHist; line: Theme.accent }
            }
            Card {
                title: "Memoria"
                width: (parent.width - 28) / 3; height: 150
                Text { text: w.sys ? Math.round(w.sys.memory.usedPercent) + " %" : "…"; color: Theme.text; font.family: Theme.font; font.pixelSize: 30; font.weight: Font.DemiBold }
                Text { y: 40; text: w.sys ? w.fmtBytes(w.sys.memory.totalBytes - w.sys.memory.availableBytes) + " de " + w.fmtBytes(w.sys.memory.totalBytes) : ""; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                Spark { id: memChart; anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom; height: 34; data: w.memHist; line: "#38d9ff" }
            }
            Card {
                title: "Disco"
                width: (parent.width - 28) / 3; height: 150
                Text { text: w.sys && w.sys.disk ? w.fmtBytes(w.sys.disk.availableBytes) : "…"; color: Theme.text; font.family: Theme.font; font.pixelSize: 30; font.weight: Font.DemiBold }
                Text { y: 40; text: w.sys && w.sys.disk ? "libres de " + w.fmtBytes(w.sys.disk.totalBytes) : ""; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                Rectangle {
                    anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom; anchors.bottomMargin: 8
                    height: 10; radius: 5; color: Theme.card2
                    Rectangle { height: parent.height; radius: 5; width: parent.width * (w.sys && w.sys.disk ? w.sys.disk.usedPercent / 100 : 0); color: Theme.good }
                }
            }
        }

        Card {
            title: "Procesos"
            width: parent.width
            height: parent.height - 150 - 16 - 30 - 16
            Row {
                id: head
                width: parent.width
                spacing: 0
                Text { width: parent.width * 0.42; text: "Nombre"; color: Theme.faint; font.family: Theme.font; font.pixelSize: 11 }
                Text { width: parent.width * 0.22; text: "Usuario"; color: Theme.faint; font.family: Theme.font; font.pixelSize: 11 }
                Text { width: parent.width * 0.12; text: "CPU"; color: Theme.faint; font.family: Theme.font; font.pixelSize: 11; horizontalAlignment: Text.AlignRight }
                Text { width: parent.width * 0.12; text: "Memoria"; color: Theme.faint; font.family: Theme.font; font.pixelSize: 11; horizontalAlignment: Text.AlignRight }
                Text { width: parent.width * 0.12; text: "PID"; color: Theme.faint; font.family: Theme.font; font.pixelSize: 11; horizontalAlignment: Text.AlignRight }
            }
            ListView {
                anchors.top: head.bottom; anchors.topMargin: 8
                anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom
                clip: true
                model: w.procs
                delegate: Item {
                    required property var modelData
                    required property int index
                    width: ListView.view.width; height: 28
                    Rectangle { anchors.fill: parent; radius: 6; color: index % 2 ? "transparent" : Theme.alpha(Theme.text, 0.03) }
                    Row {
                        anchors.verticalCenter: parent.verticalCenter
                        width: parent.width
                        Text { width: parent.width * 0.42; elide: Text.ElideRight; text: modelData.name; color: Theme.text; font.family: Theme.font; font.pixelSize: 13 }
                        Text { width: parent.width * 0.22; elide: Text.ElideRight; text: modelData.user; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                        Text { width: parent.width * 0.12; text: modelData.cpu.toFixed(1).replace(".", ",") + " %"; color: modelData.cpu > 50 ? Theme.warn : Theme.text; font.family: Theme.mono; font.pixelSize: 12; horizontalAlignment: Text.AlignRight }
                        Text { width: parent.width * 0.12; text: Math.round(modelData.rssKb / 1024) + " MB"; color: Theme.text; font.family: Theme.mono; font.pixelSize: 12; horizontalAlignment: Text.AlignRight }
                        Text { width: parent.width * 0.12; text: modelData.pid; color: Theme.faint; font.family: Theme.mono; font.pixelSize: 12; horizontalAlignment: Text.AlignRight }
                    }
                }
            }
        }

        Text {
            text: w.sys ? (w.sys.os + " · " + w.sys.kernel + " · encendido " + w.fmtUptime(w.sys.uptimeSeconds) + " · aislamiento: " + (w.sys.engine && w.sys.engine.isolation.available ? w.sys.engine.isolation.mechanism : "no disponible")) : "Conectando con NEXUS…"
            color: Theme.faint; font.family: Theme.font; font.pixelSize: 12
        }
    }
}
