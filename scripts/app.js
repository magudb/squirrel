require("../content/bulma.sass");
require("babel-polyfill");
var fetch = require("./fetch.js")

// This callback function is called when the content script has been 
// injected and returned its results

function onPageDetailsReceived(pageDetails) {
    var title = pageDetails.summary || pageDetails.title;
    document.getElementById('title').value = title
    document.getElementById('url').value = pageDetails.url;
    document.getElementById('link').value = "[" + toTitleCase(title) + "](" + getPathFromUrl(pageDetails.url) + ")"
    document.getElementById('link').focus();
}

function getPathFromUrl(url) {
    // Strip UTM parameters
    if (url.indexOf('utm_') > url.indexOf('?')) {
        url = url.replace(
            /([\?\&]utm_(reader|source|medium|campaign|content|term)=[^&#]+)/ig,
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
function toTitleCase(str) {
    return str.replace(/\w\S*/g, function (txt) { return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase(); });
}

// Global reference to the status display SPAN
var statusDisplay = null;

// POST the data to the server using XMLHttpRequest
function addBookmark() {
    // Cancel the form submit
    event.preventDefault();
    // Prepare the data to be POSTed by URLEncoding each field's contents
    var title = document.getElementById('title').value;
    var url = document.getElementById('url').value;
    var e = document.getElementById("type");
    var description = document.getElementById('description').value;
    var category = e.options[e.selectedIndex].value;

    chrome.identity.getProfileUserInfo(function (user) {
        if (!user || !user.id) {
           // notie.alert(3, 'You need a user, please login to chrome.', 5);
            return;
        }
        var model = {
            "userid": user.id,
            "title": title,
            "url": url,
            "description": description,
            "category": category,
            "date": new Date()
        };

       // notie.alert(1, JSON.stringify(model), 1.5);
        console.log(JSON.stringify(model));
        // var request = new XMLHttpRequest();
        // request.open('POST', 'http://localhost:9000/services/link', true);
        // request.setRequestHeader('Content-Type', 'application/json');
        // request.send(JSON.stringify(model));
        var myHeaders = new Headers();
        myHeaders.append("Content-Type", "application/json");

        fetch('http://localhost:9000/services/link', {
            method: 'post',
            headers: myHeaders,
            body: JSON.stringify(model)
        });
    });
}

// When the popup HTML has loaded
window.addEventListener('load', function (evt) {
    // Cache a reference to the status display SPAN
    statusDisplay = document.getElementById('status-display');
    // Handle the bookmark form submit event with our addBookmark function
    document.getElementById('addbookmark').addEventListener('submit', addBookmark);
    // Get the event page
    chrome.runtime.getBackgroundPage(function (eventPage) {
        // Call the getPageInfo function in the event page,2 passing in 
        // our onPageDetailsReceived function as the callback. This injects 
        // content.js into the current tab's HTML
        eventPage.getPageDetails(onPageDetailsReceived);
    });
});


