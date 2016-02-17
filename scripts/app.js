require("../content/bulma.sass");
require("babel-polyfill");
var Url = require("./extensions/Url.js");
var notie = require("./notification")

// This callback function is called when the content script has been 
// injected and returned its results

function onPageDetailsReceived(pageDetails) {   
    var title = toTitleCase(pageDetails.summary || pageDetails.title);    
    var url = new Url(pageDetails.url);   
    
    document.getElementById('title').value = title;
    document.getElementById('url').value = url.toString();
    document.getElementById('link').value = "[" + title + "](" + url.toString() + ")"
    document.getElementById('link').focus();
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
            notie.alert('You need a user, please login to chrome.');
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

        notie.alert(JSON.stringify(model));    
      
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


