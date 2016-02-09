var template = require("./notification.hbs");
module.exports = (function () {
    var exports = {};

    var insert = function (notification) {
        var newLyric = document.createElement("p");
        newLyric.innerHTML = notification;

        var body = document.getElementsByTagName("body")[0];
        var start = body.firstChild;
        document.insertBefore(newLyric, start);
    }

    exports.close = function () {

    };

    exports.alert = function (message) {
        var model = {
            type: "is-alert",
            message: message
        }
        var alert = template(model);
        insert(alert);
    }

    window.notification = {
        close: function () {
            exports.close();
        }
    }

    return exports;
})();

//DNS_PROBE_FINISHED_BAD_CONFIG