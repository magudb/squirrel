var template = require("./template.html");
var actions = require("../../store/actions.js");
var urlService = require("../../services/url.js");
var stringService = require("../../services/string.js");
require("fetch-polyfill");
console.log(urlService, stringService)
module.exports = {
    template: template,
    data: () => {
        return {
            loggedin:false,
            title: "",
            url: "",
            link: "",
            category: "",
            categories: [
                "What i really liked",
                "Ideas, Thoughts and process",
                "Software development",
                "C#",
                "Javascript",
                "Other Languages",
                "Html, CSS, CSS preprocessors and all thing designy",
                "Tools",
                "Cloud, DevOps and Security",
                "Containers",
                "Machine Learning and other very fancy buzzwords",
                "Videos",
                "Made me Laugh or Cry. "
            ]
        };
    },
    methods: {
        save: function () {
            var model = {
                url: this.url,
                description: this.description,
                title: this.title,
                category: this.category
            }
            this.set_bookmark(model)
        }
    },
    activate: function (done) {
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
                self.link = "[" + stringService.toTitleCase(self.title.replace("|", "-")) + "](" + urlService.SanitizeUrl(pageDetails.url) + "){:target=\"_blank\"}"
                done();
            });

        });

    },
    components: {

    },
    vuex: {
        getters: {
        },
        actions: {
            set_bookmark: actions.set_bookmark
        }
    }
};