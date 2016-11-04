var autobahn = require('autobahn');
module.exports = new Promise((resolved, rejected)=>{
    var connection = new autobahn.Connection({ url: 'ws://localhost:8080/ws', realm: 'squirrel' });
    
    connection.onopen = function (session) {
        console.log(session);
        resolved(session);
    }

    connection.open();  
});