import React, { useState, useEffect } from 'react';
import BookmarkForm from './BookmarkForm';

const App = () => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check if user is logged in using Chrome identity API
    if (chrome.identity && chrome.identity.getProfileUserInfo) {
      chrome.identity.getProfileUserInfo((userInfo) => {
        if (userInfo.email) {
          setUser(userInfo);
        }
        setLoading(false);
      });
    } else {
      setLoading(false);
    }
  }, []);

  return (
    <div className="squirrel-app">
      <header className="squirrel-header">
        <div className="squirrel-logo">🐿️</div>
        <h1 className="title is-4 has-text-white">Squirrel Link Collector</h1>
        <p className="subtitle is-6 has-text-white-ter">Collect links for your blog</p>
      </header>

      {user && (
        <div className="user-info">
          Logged in as: {user.email}
        </div>
      )}

      <main className="bookmark-form">
        {!loading && <BookmarkForm />}
      </main>
    </div>
  );
};

export default App;