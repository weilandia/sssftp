var AWS = require('aws-sdk'),
    Promise = require('bluebird')
    s3 = Promise.promisifyAll(require('node-s3-encryption-client')),
    awsS3 = Promise.promisifyAll(new AWS.S3()),
    sftpHelper = require('./lib/sftpHelper'),
    sqs = Promise.promisifyAll(new AWS.SQS()),
    fs = require('fs');

exports.handler = function(event, context, cb) {
  return exports.pollSftp(event, context);
};

exports.pollSftp = function(event, context) {
  return Promise.try(function() {
    var streamNames = [];
    if (event.resources) {
      if (Array.isArray(event.resources)) {
        event.resources.forEach(function(resource) {
          streamNames = streamNames.concat(exports.scheduledEventResourceToStreamNames(resource));
        });
      } else {
        streamNames = exports.scheduledEventResourceToStreamNames(event.resources);
      }
    }
    if (streamNames.length === 0) throw new Error("streamNames required for config discovery");
    return function(config) {
      return Promise.map(
        streamNames,
        function(streamName) {
          streamName = streamName.trim();
          var streamConfig = sftpConfigDetails()[streamName];
          if (!streamConfig) throw new Error("streamName [" + streamName + "] not found in config");
          return exports.getSftpConfig(streamConfig)
          .then(function(sftpConfig) {
            var s3Location = streamConfig.s3Location;
            if (!s3Location) throw new Error("streamName [" + streamName + "] has no s3Location");
            console.info("Attempting connection for [" + streamName + "]: host[" + sftpConfig.host + "], username[" + sftpConfig.username + "]");
            return sftpHelper.withSftpClient(sftpConfig, function(sftp) {
              return exports.syncSftpDir(sftp, streamConfig.sftpLocation || '/', s3Location, streamConfig.fileRetentionDays);
            })
            .then(function(results) {
              console.info("[" + streamName + "]: Moved " + flatten(results).length + " files from SFTP to S3");
              return results;
            });
          });
        }
      );
    }();
  })
  .then(function(result) {
    context.succeed(flatten(result));
  })
  .catch(function(err) {
    console.error(err.stack || err);
    context.fail(err);
    throw err;
  });
};

exports.getFilePathArray = function(filePath) {
  return (filePath || '').split('/').filter(function(s) { return s ? true : false; });
};

exports.getSftpConfig = function(config) {
  return Promise.try(function() {
    if (!config.sftpConfig) throw new Error("SFTP config not found");
    if (config.sftpConfig.s3PrivateKey) {
      var bucketDelimiterLocation = config.sftpConfig.s3PrivateKey.indexOf("/");
      return s3.getObjectAsync({
        Bucket: config.sftpConfig.s3PrivateKey.substr(0, bucketDelimiterLocation),
        Key: config.sftpConfig.s3PrivateKey.substr(bucketDelimiterLocation + 1)
      })
      .then(function(objectData) {
        config.sftpConfig.privateKey = objectData.Body.toString();
        delete config.sftpConfig.s3PrivateKey;
        return config.sftpConfig;
      });
    } else return config.sftpConfig;
  });
};

exports.scheduledEventResourceToStreamNames = function(resource) {
  return resource.substr(resource.toLowerCase().indexOf("rule/") + 5).split(".");
};

exports.syncSftpDir = function(sftp, sftpDir, s3Location, topDir) {
  return sftp.readdirAsync(sftpDir)
  .then(function(dirList) {
    return Promise.mapSeries(
      dirList,
      function(fileInfo) {
        return Promise.try(function() {
          if (fileInfo.filename == 'download') {
            return exports.syncSftpDir(sftp, sftpDir + '/' + fileInfo.filename, s3Location, fileInfo.filename);
          } else if (topDir) {
            //WORK HERE
            return sftpHelper.processFile(sftp, sftpDir, fileInfo.filename, function(body) {
              var s3Path = exports.getFilePathArray(s3Location),
                  sftpPath = exports.getFilePathArray(sftpDir),
                  topDirPath = exports.getFilePathArray(topDir);
              var s3Bucket = s3Path.shift();
              for (var i = 0; i < topDirPath.length; i++) sftpPath.shift(); // Remove the origin path from the destination directory
              var destDir = s3Path.concat(sftpPath).join('/');
              if (destDir.length > 0) destDir += '/';
              console.info("Writing " + s3Bucket + "/" + destDir + fileInfo.filename + "...");
              return s3.putObjectAsync({
                Bucket: s3Bucket,
                Key: destDir + fileInfo.filename,
                Body: body,
                Metadata: {
                  "synched": "true"
                }
              })
              .then(function(data) {
                console.info("...done");
                return data;
              });
            });
          }
        });
      }
    );
  });
};

function flatten(arr) {
  return arr.reduce(function(a, b) {
    if (Array.isArray(b)) {
      return a.concat(flatten(b));
    } else if (b) {
      a.push(b);
      return a;
    } else {
      return a;
    }
  }, []);
}

function sftpConfigDetails() {
  var responsys_key = fs.readFileSync(process.env.SFTP_KEY);
  return {
    "responsys": {
      "s3Location": "your-bucket-name/destination/directory",
      "sftpConfig": {
        "host": "files.responsys.net",
        "port": 22,
        "privateKey": responsys_key,
        "username": "stackcomrc_scp"
      },
      "sftpLocation": "/home/cli/stackcomrc_scp/"
    }
  };
}
