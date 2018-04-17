import React, { Component } from 'react';
import logo from './logo.svg';
import './App.css';
import Uploader from './components/uploader';

class App extends Component {
  render() {
    return (
      <div className="App">
        <Header />
        <Uploader />
      </div>
    );
  }
}

export default App;
