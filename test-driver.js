(function () {
  "use strict";

  require('Array.prototype.forEachAsync');

  var npm = require('npm')
    , traverser = require('./dependency-traverser')
    , fs = require('fs')
    , path = require('path')
    , allModules = {}
    , reIsLocal = /^\.{0,2}\//
    , handleModule = require('./implicit-dependencies')
      // ls ~/Code/node/lib/ | grep '' | cut -d'.' -f1 | while read M; do echo , \"${M}\"; done
    , builtIns = [
          "_debugger"
        , "_linklist"
        , "assert"
        , "buffer"
        , "child_process"
        , "console"
        , "constants"
        , "crypto"
        , "dgram"
        , "dns"
        , "events"
        , "freelist"
        , "fs"
        , "http"
        , "https"
        , "module"
        , "net"
        , "os"
        , "path"
        , "querystring"
        , "readline"
        , "repl"
        , "stream"
        , "string_decoder"
        , "sys"
        , "timers"
        , "tls"
        , "tty"
        , "tty_posix"
        , "tty_win32"
        , "url"
        , "util"
        , "vm"
      ]
      // http://www.jslint.com/lint.html#browser
      // http://www.jslint.com/jslint.js
    , browserBuiltIns = [
          "File"
        , "FileWriter"
        , "FileReader"
        , "Uint8Array"
        , "clearInterval"
        , "clearTimeout"
        , "document"
        , "event"
        , "frames"
        , "history"
        , "Image"
        , 'localStorage'
        , "location"
        , "name"
        , "navigator"
        , "Option"
        , "parent"
        , "screen"
        , "sessionStorage"
        , "setInterval"
        , "setTimeout"
        , "Storage"
        , "window"
        , "XMLHttpRequest"
      ]
    ;

  function isCoreModule(modulename) {
    return -1 !== builtIns.indexOf(modulename);
  }
  
  function isBrowserGlobal(modulename) {
    return -1 !== browserBuiltIns.indexOf(modulename);
  }

  // https://github.com/isaacs/npm/issues/1493
  // this fixes a confusing part of the API
  function hotFix1493(map) {
    var fixedMap = map
      , fixedArray = []
      ;

    Object.keys(map).forEach(function (version) {
      var pkg = map[version][''];
      fixedMap[pkg.version] = pkg;
      delete map[version][''];
      delete map[version];
    });

    Object.keys(fixedMap).sort().forEach(function (version) {
      fixedArray.push(fixedMap[version]);
    });

    return fixedArray;
  }

  var cachedNpmModules = {};
  function view(pkg, callback) {
    var nameOnly;

    function onViewable(err, map, array) {
      callback(err, map, array);
    }

    function fixView(err, map) {
      var array
        ;

      if (!err) {
        array = hotFix1493(map);
        cachedNpmModules[nameOnly] = { map: map, array: array };
      }


      console.log('reading "' + nameOnly + '" from npm');
      onViewable(err, map, array);
    }

    function manglePackageJson(err, data) {
      var map = {}
        , array = []
        ;

      if (err) {
        console.error('Could not read "' + pkg + '/package.json'  + '"');
        onViewable(err);
        return;
      }

      try {
        data = JSON.parse(data)
      } catch(e) {
        console.error('Could not parse "' + pkg + '/package.json'  + '"');
        onViewable(e);
        return;
      }

      map[data.version || '0.0.0'] = data;
      array.push(data);

      onViewable(err, map, array);
    }

    if (reIsLocal.exec(pkg)) {
      pkg = path.resolve(pkg);
      fs.readFile(pkg + '/package.json', manglePackageJson);
    } else {
      // TODO handle version comparison properly
      nameOnly = pkg.split('@')[0];
      if (cachedNpmModules[nameOnly]) {
        onViewable(null, cachedNpmModules[nameOnly].map, cachedNpmModules[nameOnly].array);
        return;
      }
      npm.commands.view([nameOnly], true, fixView);
    }
  }

  function sortDeps(dependencyTree, callback) {
    var missingDeps = {}
      , npmDeps = {}
      , localDeps = {}
      , builtIn = {}
      ;

    function sortDepsHelper(dependencyTree, callback) {
      function eachDep(next, modulename) {
        var module = dependencyTree[modulename]
          ;

        function onReady() {
          sortDepsHelper(module.dependencyTree, next);
        }

        function onNpm(err, map, array) {
          if (err) {
            missingDeps[modulename] = module;
          } else {
            npmDeps[modulename] = array[0];
            module.npm = true;
          }

          onReady();
        }

        if (isCoreModule(modulename)) {
          builtIn[modulename] = module;
        }
        else if (module.error) {
          missingDeps[modulename] = module;
        }
        else if (module.pathname && !module.warning) {
          localDeps[modulename] = module;
        }
        else {
          if (!cachedNpmModules[modulename]) {
            view(modulename, onNpm);
            return;
          }
          console.log(cachedNpmModules[modulename]);
          onNpm(null, cachedNpmModules[modulename].map, cachedNpmModules[modulename].array);
        }

        onReady();
      }

      function onDone() {
        callback(null, missingDeps, builtIn, localDeps, npmDeps);
      }

      Object.keys(dependencyTree || {}).forEachAsync(eachDep).then(onDone);
    }

    sortDepsHelper(dependencyTree, callback);
  }

  function getAllNpmDeps(masterTree, callback) {
    var modules = {}
      ;

    function helper(tree, callback) {
      var depnames
        , depnamesObj
        ;

      //console.log('tree:', tree);

      function eachDep(next, modulename) {
        var tuple = modulename.split('@')
          , version = tuple[1] || '>= 0.0.0'
          ;

        modulename = tuple[0];

        function onNpm(err, map, array) {
          if (err) {
            tree.dependencyTree[modulename] = {
                name: modulename
              , version: version
              , error: err
              , npm: true
            };
          } else {
            tree.dependencyTree[modulename] = array[array.length - 1];
            if (!tree.dependencyTree[modulename]) {
              console.error(modulename);
            }
            tree.dependencyTree[modulename].npm = true;
          }

          modules[modulename] = modules[modulename] || tree.dependencyTree[modulename];
          helper(tree.dependencyTree[modulename], next);
        }

        view(modulename + '@' + version, onNpm);
      }

      function onDone() {
        callback(null, modules);
      }

      depnamesObj = (tree.ender && tree.ender.dependencies) || tree.dependencies || [];
      if (!Array.isArray(depnames)) {
        depnames = [];
        Object.keys(depnamesObj).forEach(function (name) {
          var version = depnamesObj[name] || ''
            ;

          version = version ? '@' + version.trim() : '';

          depnames.push(name + version);
        });
      }

      tree.dependencyTree = {};
      (depnames || []).forEachAsync(eachDep).then(onDone);
    }

    helper(masterTree, callback);
  }

  var modulePath = __dirname + '/' + 'test_modules/foomodule';
  handleModule(modulePath, function (err, tree) {
      var missing = []
        , extra = []
        , sortedModules
        ;

      if (err) {
        console.error('ERR: [handleModule]');
        throw err;
        console.error(err);
        return;
      }

      fs.readFile(modulePath + '/package.json', 'utf8', function (err, data) {

        data = JSON.parse(data);
        data.dependencyTree = data.dependencyTree || {};

        Object.keys(tree.dependencyTree).forEach(function (key) {
          if (!data.dependencyTree[key] || tree.dependencyTree[key].error) {
            missing.push(key);
          }
        });

        Object.keys(data.dependencyTree).forEach(function (key) {
          if (!tree.dependencyTree[key]) {
            extra.push(key);
          }
        });

        npm.load({}, function () {

          sortDeps(tree.dependencyTree, function (err, missing, builtIn, local, npmDeps) {
            console.log('[ERROR]:', err);
            console.log('[MISSING]:', missing);
            console.log('[BUILT-IN]:', builtIn);
            console.log('[LOCAL]:', local);
          /*
            console.log('[NPM]:', npmDeps);
            Object.keys(npmDeps).forEachAsync(function (next, modulename) {
              var module = npmDeps[modulename];
              view
            });
          */
          });

          var installedModules = {};
          fs.readdir(__dirname + '/' + 'node_modules', function (err, nodes) {
            nodes.forEach(function (nodename) {
              installedModules[nodename] = true;
            });
          });

          function doInstall(next, depname) {
            if (installedModules[depname]) {
              console.log('Already installed', depname);
              next();
              return;
            }

            npm.commands.install(__dirname + '/', [depname], function (err, array, map, versionAndPath) {
              if (err) {
                console.error('[NPM] [' + depname + ']', err.message);
                return;
              }
              //console.log('Installed', versionAndPath);
              next();
            });
          }

          getAllNpmDeps(data, function (err, modules) {
            var map
              , array
              ;

            //console.log(data);
            //console.log(arguments);
            map = traverser.mapByDepth(data);
            array = traverser.reduceByDepth(map);
            //console.log(map);
            //console.log(array);

            function afterInstall() {
              array.forEachAsync(getLocalDeps);
            }

            array.forEachAsync(doInstall).then(function () {
              console.log('All modules installed');
              console.log(data && true);
            }).then(afterInstall);
          });

        });
      });
  });

  // getRequires
  // getDependencies
  // getAllDependencies
  // isCoreModule

}());
