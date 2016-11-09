module.exports = (function () {

    var ensurePrefixSlash = function (path) {
        return path.replace(/^\/?/, '/');
    }

    var cleanUri = function (url) {
        // Strip UTM parameters
        if (url.indexOf('utm_') > url.indexOf('?')) {
            url = url.replace(
                /([\?\&]utm_(reader|source|medium|campaign|content|term)=[^&#]+)/ig,
                '');
        }

        if (url.indexOf("mkt_tok") > url.indexOf('?')) {
            url = url.replace(
                /([\?\&](mkt_tok)=[^&#]+)/ig,
                '');
        }

        // Strip MailChimp parameters
        if (url.indexOf('mc_eid') > url.indexOf('?') || url.indexOf('mc_cid') > url.indexOf('?')) {
            url = url.replace(
                /([\?\&](mc_cid|mc_eid)=[^&#]+)/ig,
                '');
        }

        // Strip YouTube parameters
        if (url.indexOf('http://www.youtube.com/watch') == 0 ||
            url.indexOf('https://www.youtube.com/watch') == 0) {
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

    var parse = function (self, url) {
        var parser = document.createElement('a');
        parser.href = url;
        self.protocol = parser.protocol.replace(":", "");
        self.host = parser.hostname;
        var pathname = parser.pathname;
        self.path = ensurePrefixSlash(pathname);
        self.hash = parser.hash.replace(/^#/, '');
        var queryString = cleanUri(parser.search).replace(/^\?/, '');
        self.query = new QueryString(queryString);
    };

    var Url = function (url) {
        parse(this, url);
    }

    Url.prototype.toString = function () {
        return (
            (this.protocol && (this.protocol + '://')) +
            (this.host && this.host) +
            (this.path && this.path) +
            (this.query.toString() && ('?' + this.query)) +
            (this.hash && ('#' + this.hash))
            );
    };

    function QueryString(queryString) {
        var queryStringRegex = /([^=&]+)(=([^&]*))?/g;
        var match;
        //Creating a object notation
        while ((match = queryStringRegex.exec(queryString))) {
            var key = decodeURIComponent(match[1].replace(/\+/g, ' '));
            var value = match[3] ? decodeURIComponent(match[3]) : '';
            this[key] = value;
        }
    }

    QueryString.prototype.toString = function () {
        var queryString = '';

        for (var index in this) {
            var element = this[index];
            if (element instanceof Function || element === null) {
                continue;
            }
            queryString += queryString ? '&' : '';
            queryString += encodeURIComponent(index) + '=' + encodeURIComponent(element);
        }

        return queryString;
    };

    return Url;
})();