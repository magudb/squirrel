require("../content/bulma.sass");
require("babel-polyfill");

var urlService = require("./services/url.js");
var stringService = require("./services/string.js");

var actions = require("./store/actions.js");
var Vue = require('vue');
var Vuex = require("vuex");
Vue.use(Vuex);
Vue.config.devtools = true;

var app = new Vue({
    mixins:[],
    store: require("./store")(),
    el: '#squirrel',
    components: {
        bookmaker:require("./components/bookmaker")
    }
});







