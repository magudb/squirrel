webpackJsonp([1],{

/***/ 0:
/***/ function(module, exports, __webpack_require__) {

	"use strict";

	__webpack_require__(303);
	__webpack_require__(121);

	var urlService = __webpack_require__(87);
	var stringService = __webpack_require__(86);

	var actions = __webpack_require__(88);
	var Vue = __webpack_require__(307);
	var Vuex = __webpack_require__(118);
	Vue.use(Vuex);
	Vue.config.devtools = true;

	var app = new Vue({
	    mixins: [],
	    store: __webpack_require__(120)(),
	    el: '#squirrel',
	    components: {
	        bookmaker: __webpack_require__(119)
	    }
	});

/***/ },

/***/ 86:
/***/ function(module, exports) {

	"use strict";

	module.exports = {
	    toTitleCase: function toTitleCase(str) {
	        return str.replace(/\w\S*/g, function (txt) {
	            return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
	        });
	    }
	};

/***/ },

/***/ 87:
/***/ function(module, exports) {

	'use strict';

	module.exports = {
	    SanitizeUrl: function SanitizeUrl(url) {
	        // Strip UTM parameters
	        if (url.indexOf('utm_') > url.indexOf('?')) {
	            url = url.replace(/([\?\&]utm_(reader|source|medium|campaign|content|term)=[^&#]+)/ig, '');
	        }

	        if (url.indexOf("mkt_tok") > url.indexOf('?')) {
	            url = url.replace(/([\?\&](mkt_tok)=[^&#]+)/ig, '');
	        }

	        // Strip MailChimp parameters
	        if (url.indexOf('mc_eid') > url.indexOf('?') || url.indexOf('mc_cid') > url.indexOf('?')) {
	            url = url.replace(/([\?\&](mc_cid|mc_eid)=[^&#]+)/ig, '');
	        }

	        // Strip YouTube parameters
	        if (url.indexOf('http://www.youtube.com/watch') == 0 || url.indexOf('https://www.youtube.com/watch') == 0) {
	            url = url.replace(/([\?\&](feature|app|ac|src_vid|annotation_id)=[^&#]*)/ig, '');
	        }

	        // Strip Yandex openstat parameters
	        if (url.indexOf('_openstat') > url.indexOf('?')) {
	            url = url.replace(/([\?\&]_openstat=[^&#]+)/ig, '');
	        }

	        // If there were other query parameters, and the stripped ones were first,
	        // then we need to convert the first ampersand to a ? to still have a valid
	        // URL.
	        if (url.indexOf('&') != -1 && url.indexOf('?') == -1) {
	            url = url.replace('&', '?');
	        }

	        return url;
	    }
	};

/***/ },

/***/ 88:
/***/ function(module, exports) {

	"use strict";

	module.exports = {
	   set_bookmark: function set_bookmark(state, model) {
	      console.log(model);
	      state.dispatch("SET_BOOKMARK", model);
	   }
	};

/***/ },

/***/ 119:
/***/ function(module, exports, __webpack_require__) {

	"use strict";

	var template = __webpack_require__(305);
	var actions = __webpack_require__(88);
	var urlService = __webpack_require__(87);
	var stringService = __webpack_require__(86);
	__webpack_require__(304);
	console.log(urlService, stringService);
	module.exports = {
	    template: template,
	    data: function data() {
	        return {
	            loggedin: false,
	            title: "",
	            url: "",
	            link: "",
	            category: "",
	            categories: ["What i really liked", "Ideas, Thoughts and process", "Software development", "C#", "Javascript", "Other Languages", "Html, CSS, CSS preprocessors and all thing designy", "Tools", "Cloud, DevOps and Security", "Containers", "Machine Learning and other very fancy buzzwords", "Videos", "Made me Laugh or Cry. "]
	        };
	    },
	    methods: {
	        save: function save() {
	            var model = {
	                url: this.url,
	                description: this.description,
	                title: this.title,
	                category: this.category
	            };
	            this.set_bookmark(model);
	        }
	    },
	    activate: function activate(done) {
	        var self = this;
	        chrome.identity.getProfileUserInfo(function (user) {
	            if (user && user.id) {
	                self.loggedin = true;
	            }
	        });
	        chrome.runtime.getBackgroundPage(function (eventPage) {
	            eventPage.getPageDetails(function (pageDetails) {
	                self.title = pageDetails.summary || pageDetails.title;
	                self.url = urlService.SanitizeUrl(pageDetails.url);
	                self.link = "[" + stringService.toTitleCase(self.title) + "](" + urlService.SanitizeUrl(pageDetails.url) + ")";
	                done();
	            });
	        });
	    },
	    components: {},
	    vuex: {
	        getters: {},
	        actions: {
	            set_bookmark: actions.set_bookmark
	        }
	    }
	};

/***/ },

/***/ 120:
/***/ function(module, exports, __webpack_require__) {

	"use strict";

	var _logger = __webpack_require__(308);

	var _logger2 = _interopRequireDefault(_logger);

	function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

	var Vuex = __webpack_require__(118);

	module.exports = function () {
	    var state = {
	        activeBookmark: {}
	    };

	    var mutations = {
	        SET_BOOKMARK: function SET_BOOKMARK(state, mutations) {
	            state.activeBookmark = mutations;
	        }
	    };

	    return new Vuex.Store({
	        state: state,
	        mutations: mutations,
	        middlewares: [_logger2.default]
	    });
	};

/***/ },

/***/ 303:
/***/ function(module, exports) {

	// removed by extract-text-webpack-plugin

/***/ },

/***/ 305:
/***/ function(module, exports) {

	module.exports = "<div id=\"addbookmark\">\r\n    <p class=\"control\">\r\n        <input class=\"input is-medium\" type=\"text\" id=\"title\" name=\"title\" size=\"50\" value=\"\" placeholder=\"Title\" v-model=\"title\"\r\n        />\r\n    </p>\r\n    <p class=\"control\">\r\n        <input class=\"input is-medium\" type=\"text\" id=\"url\" name=\"url\" size=\"50\" value=\"\" v-model=\"url\" />\r\n    </p>\r\n    <p class=\"control\">\r\n        <select id=\"type\" class=\"select is-medium\" v-model=\"category\">\r\n            <option v-for=\"category in categories\" v-bind:value=\"category\">{{category}}</option>\r\n        </select>\r\n    </p>\r\n    <p class=\"control\">\r\n        <textarea id=\"description\" name=\"description\" class=\"textarea is-medium\" v-model=\"description\"></textarea>\r\n    </p>\r\n    <p class=\"control\">\r\n        <input type=\"text\" id=\"link\" value=\"\" class=\"input is-medium\" v-model=\"link\" autofocus />\r\n    </p>\r\n    <p class=\"control\">\r\n        <input id=\"save\" type=\"submit\" value=\"Save\" class=\"button is-primary is-medium\" v-on:click=\"save\" />\r\n        <span id=\"status-display\"></span>\r\n        <span id=\"output\"></span>\r\n    </p>\r\n    </p>\r\n</div>";

/***/ }

});