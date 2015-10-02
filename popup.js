// This callback function is called when the content script has been 
// injected and returned its results

function onPageDetailsReceived(pageDetails) {
  document.getElementById('title').value = pageDetails.summary || pageDetails.title;
  document.getElementById('url').value = pageDetails.url;

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
  var category = e.options[e.selectedIndex].value;

  chrome.identity.getProfileUserInfo(function (user) {
    if (!user || !user.id) {
      alert("You need a user, please login to chrome");
    }
    var model = {
      "userid": user.id,
      "title": title,
      "url": url,
      "category": category,
      "date": new Date()
    };

    
    console.log(model);
    var request = new XMLHttpRequest();
    request.open('POST', 'http://localhost:3000/api/links/', true);
    request.setRequestHeader('Content-Type', 'application/json');
    request.send(JSON.stringify(model));
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
    // Call the getPageInfo function in the event page, passing in 
    // our onPageDetailsReceived function as the callback. This injects 
    // content.js into the current tab's HTML
    eventPage.getPageDetails(onPageDetailsReceived);
  });
});


