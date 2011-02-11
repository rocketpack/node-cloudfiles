/*
 * core.js: Core functions for accessing Rackspace CloudFiles
 *
 * (C) 2010 Nodejitsu Inc.
 * MIT LICENSE
 *
 */

require.paths.unshift(require('path').join(__dirname, '..'));

var cloudfiles = require('cloudfiles'),
    sys = require('sys'),
    url = require('url'),
    fs = require('fs'),
    eyes = require('eyes'),
    http = require('http'),
    spawn = require('child_process').spawn,
    exec = require('child_process').exec,
    request = require('request');

var utils = exports;

// Failure HTTP Response codes based
// off Rackspace CloudFiles specification.
var failCodes = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Resize not allowed",
  404: "Item not found",
  409: "Build in progress",
  413: "Over Limit",
  415: "Bad Media Type",
  500: "Fault",
  503: "Service Unavailable"
};

// Export the set of Failure Codes
utils.failCodes = failCodes;

// Success HTTP Response codes based
// off Rackspace CloudFiles specification.
var successCodes = {
  200: "OK",
  202: "Accepted",
  203: "Non-authoritative information",
  204: "No content",
};

// Export the set of Success Codes
utils.successCodes = successCodes;

// 
// Checks if a directory exists. If not, creates that directory
//
utils.statOrMkdir = function (path, callback) {
  fs.stat(path, function (err, stats) {
    if (err) {
      exec('mkdir -p -m 0755 ' + path, function (err, stdout, stderr) {
        callback(null, path);
      });
      return;
    }
    
    callback(null, path);
  });
}
 
//
// Core method that actually sends requests to Rackspace.
// This method is designed to be flexible w.r.t. arguments 
// and continuation passing given the wide range of different
// requests required to fully implement the CloudFiles API.
// 
// Continuations: 
//   1. 'callback': The callback passed into every node-cloudfiles method
//   2. 'success':  A callback that will only be called on successful requests.
//                  This is used throughout node-cloudfiles to conditionally
//                  do post-request processing such as JSON parsing.
//
// Possible Arguments (1 & 2 are equivalent):
//   1. utils.rackspace('some-fully-qualified-url', client, callback, success)
//   2. utils.rackspace('GET', 'some-fully-qualified-url', client, callback, success)
//   3. utils.rackspace('DELETE', 'some-fully-qualified-url', client, callback, success)
//   4. utils.rackspace({ method: 'POST', uri: 'some-url', client: new Cloudfiles(), body: { some: 'body'} }, callback, success)
//
utils.rackspace = function () {
  var args = Array.prototype.slice.call(arguments),
      success = (typeof(args[args.length - 1]) === 'function') && args.pop(),
      callback = (typeof(args[args.length - 1]) === 'function') && args.pop(),
      uri, method, requestBody, responseBodyStream, bodyStream, client, headers = {};
      
  // Now that we've popped off the two callbacks
  // We can make decisions about other arguments
  if (args.length == 1) {  
    method = args[0]['method'] || 'GET';
    uri = args[0]['uri'];
    client = args[0]['client'];
    requestBody = args[0]['body'];
    headers = args[0]['headers'] || {};
    bodyStream = args[0]['bodyStream'] || null;
    responseBodyStream = args[0]['responseBodyStream'] || null;
  }
  else if (args.length === 2) {
    // If we got a string assume that it's the URI 
    method = 'GET';
    uri = args[0];
    client = args[1];
  }
  else {
    method = args[0];
    uri = args[1];
    client = args[2];
  }
  
  //
  // Makes the raw request to Rackspace Cloudfiles
  //
  function makeRequest (target) {
    // Append the X-Auth-Token header for Rackspace authentication
    headers['X-AUTH-TOKEN'] = client.config.authToken;

    var serverOptions = {
      uri: target,
      method: method,
      headers: headers,
      pool: false
    };

    if (typeof requestBody !== 'undefined' && !serverOptions.headers['Content-Type']) {
      serverOptions.headers['Content-Type'] = 'application/json';
      serverOptions.body = JSON.stringify(requestBody);
    } 
    else if (typeof requestBody !== 'undefined') {
      serverOptions.body = requestBody;
    }

    var results = {}, out;
    out = request(serverOptions, function (err, res, body) {
      if (err) {
        if (callback) callback(err);
        return;
      }

      var statusCode = res.statusCode.toString();
      if (Object.keys(failCodes).indexOf(statusCode) !== -1) {
        if (callback) {
          callback(new Error('Rackspace Error (' + statusCode + '): ' + failCodes[statusCode]));
        }
        return;
      }

      if (!responseBodyStream && !bodyStream) {
        success(body, res);
      }
      else {
        results.body = body;
        results.res = res;
      }
    });
    
    if (bodyStream) {
      bodyStream.pipe(out);
      out.on('close', function () {
        success(results.body, results.res);
      });
    }
    
    if (responseBodyStream) {
      out.pipe(responseBodyStream);
      responseBodyStream.on('close', function () {
        success(results.body, results.res);
      });
    }
  }
  
  if (client.authorized) {
    makeRequest(uri);
  }
  else {
    client.setAuth(function (err, res) {
      if (err) return callback(err);
      
      makeRequest(client.storageUrl(uri.slice(1)));
    });
  }
};

// Runs a array of functions with callback argument
// And calls finish at the end of execution
utils.runBatch = function(fns, finish) {
  var finished = 0,
      total = fns.length,
      errors = new Array(total),
      was_error = false,
      results = new Array(total);
      
  fns.forEach(function(fn, i) {
    var once = false;
    
    function next(err, value) {
      // Can be called only one time
      if (once) return;      
      once = true;
      
      // If have error - push them into errors
      if (err) {
        was_error = true;
        errors[i] = err;
      } else {
        results[i] = value;
      }
            
      if (++finished === total) finish(was_error ? errors : null, results);
    }
    
    var value = fn(next);
    // If function returns value - it won't be working in async mode
    if (value !== undefined) next(null, value);
  });
  
  if (fns.length === 0) finish(null, []);
};

