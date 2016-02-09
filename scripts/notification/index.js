var template = require("./notification.hbs");
module.exports = (function () {
    var exports = {};

    var insert = function (notification) {
        var d1 = document.querySelector('body');

        d1.insertAdjacentHTML('afterbegin', notification);
    }

    exports.close = function () {
        console.log("exports.close");
        var d1 = document.querySelector('#notification');
        d1.remove();
         var el = document.querySelector("#notification_close");
        el.removeEventListener("click", exports.close);
    };

    exports.alert = function (message) {
        var model = {
            type: "is-danger",
            message: message
        }
        var alert = template(model);

        insert(alert);
        
        var el = document.querySelector("#notification_close");
        el.addEventListener("click", exports.close);
    }
 
    return exports;
})();

//DNS_PROBE_FINISHED_BAD_CONFIG