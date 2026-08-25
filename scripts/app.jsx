import React from 'react';
import ReactDOM from 'react-dom/client';
import Bookmaker from './components/Bookmaker';
import '../content/bulma.sass';

const App = () => {
    return (
        <div id="squirrel">
            <header className="header">
                <div className="container">
                    <div className="header-left">
                        <a className="header-item" href="https://www.wesquirrel.com">
                            WeSquirrel
                        </a>
                    </div>
                    <span className="header-toggle">
                        <span></span>
                        <span></span>
                        <span></span>
                    </span>
                </div>
            </header>
            <section className="section">
                <div className="container">
                    <div className="columns">
                        <div className="column">
                            <Bookmaker />
                        </div>
                    </div>
                </div>
            </section>
            <footer className="footer">
                <div className="container">
                    <div className="content is-centered">
                        <strong>WeSquirrel</strong> by <a href="http://udbjorg.net">Magnus Udbjorg</a>.
                    </div>
                </div>
            </footer>
        </div>
    );
};

// Wait for DOM to be ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        const root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(<App />);
    });
} else {
    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(<App />);
}