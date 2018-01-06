module.exports = {
    encodePath: function (str) {
        return str.split('/').map((p)=>encodeURIComponent(p)).join('/')
    },
    decodePath: function (str) {
        return str.split('/').map((p)=>decodeURIComponent(p)).join('/')
    }
}