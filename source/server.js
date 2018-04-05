'use strict';

const config = require('./config.json');
const express = require('express');

const app = express();
app.get('/ok', function(req, res) {
    console.log('OK');
    res.send('eyeballr OK');
});

app.listen(config.API_PORT, config.API_HOST);
console.log(`running on http://${config.API_HOST}:${config.API_PORT}`);
