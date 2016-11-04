var Vuex = require("vuex");
import createLogger from 'vuex/logger'
module.exports = function() {  
    var state = {
       activeBookmark:{}
    };

    var mutations = {
        SET_BOOKMARK (state, mutations) {
            state.activeBookmark = mutations;
        },
    };

    return new Vuex.Store({
        state,
        mutations,
        middlewares: [createLogger]
    });
};