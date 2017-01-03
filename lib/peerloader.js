var util = require('./util');
var EventEmitter = require('eventemitter3');
var Peer = require('./peer');

var simpleSegmentLength = 1024*1024;

function PeerFile(sourceType, src, type) {
    this.sourceType = sourceType;
    this.src = src;
    this.type = type;
    this.size = 0;
    this.segments = [];
    this.nextsegment = 0;

    this._aborted = false;
    EventEmitter.call(this);
}

util.inherits(PeerFile, EventEmitter);

PeerFile.prototype.init = function() {
   this._loadSegmentsList();
};

PeerFile.prototype.getLoaderSegments = function() {
    var segments = [];
    if(this.segments.length > 0) {
        for(var i=0; i<this.segments.length; i++) {
            var s = this.segments[i];
            if(s.data) {
                segments.push(s.id);
            }
        }
    }

    return segments;
};

PeerFile.prototype._loadSegmentsList = function() {
    var self = this;
    var err = null;

    if(self.sourceType == "simple") {
        var xhr = new XMLHttpRequest();

        if(window.location.host != util.httpUrlHost(self.src)) {
            xhr.withCredentials = true;
        }
        xhr.open('HEAD', self.src, true);
        xhr.onload = function () {
            var headers_all = util.httpParseHeaders(xhr.getAllResponseHeaders());
            if(headers_all == false) {
                return;
            }

            self.type = headers_all['Content-Type'];
            self.size = parseInt(headers_all['Content-Length'], 10);

            var indx = 0;
            for(var i=0;i<self.size;i+=simpleSegmentLength) {
                var segment = {
                    'i': indx,
                    'id': 's' + i,
                    'range': [i, Math.min(i+simpleSegmentLength-1, self.size)],
                    'data': null
                };
                self.segments.push(segment);
                indx += 1;
            }

            self.emit('init');
        };
        xhr.onerror = function() {
            err = util.error('HTTP error. Status: ' + xhr.status + ' Message: ' + xhr.statusText);
            self.emit('error', err);
        };
        xhr.send();
    }
    return err;
};

PeerFile.prototype._setSegmentData = function(indx, data) {
  if(this.segments[indx] != undefined) {
      this.segments[indx].data = data;

      var segmentsLen = this.segments.length;
      var segmentsLoaded = 0;
      for(var i=0;i<segmentsLen;i++) {
          var segment = this.segments[i];
          if(segment.data) {
              segmentsLoaded++;

              if(i == this.nextsegment) {
                  this.emit('nextsegment', i, segment.data);
                  this.nextsegment++;
              }
          }
      }

      if(segmentsLoaded == segmentsLen) {
          this.emit('load');
      }
  }
};

PeerFile.prototype._getSegmentData = function(segmentId) {
    for(var i=0;i<this.segments.length;i++) {
        var segment = this.segments[i];
        if(segment.id == segmentId) {
            if(segment.data) {
                return segment.data
            } else {
                return false;
            }
        }
    }
    return false;
}

/*

 */
function PeerLoader(options) {
    if (!(this instanceof PeerLoader)) return new PeerLoader(options);
    EventEmitter.call(this);

    this.options = options;
    this.peerList = {};
    this.peerPool = {};
    this.peerSegments = {};
    this.requestQueue = {};

    this.peerFile = null;
}

util.inherits(PeerLoader, EventEmitter);

PeerLoader.prototype.load = function(peerFile) {
    var self = this;

    if(peerFile.constructor !== PeerFile) {
        self.emitError('FileObject', 'Input parameter mast be PeerFile type');
        return;
    }
    peerFile.on('error', function(err) {
        self._abort(err)
    });
    peerFile.init();

    if(self._aborted) {
        return;
    }


    this.peer = new Peer(this.options);
    this.peer.on('close', function(){
    });
    this.peer.on('connection', function(conn) {
        self._addPeer(conn);
    });
    this.peer.on('peers', function(peers) {
        self._updatePeers(peers);
    });
    this.peer.on('segments', function(segments) {
        util.log('Update segments', segments);
        self._updateSegments(segments);
    });

    this.peerFile = peerFile;
    this.peerFile.on('init', function(){
        var allSegments = peerFile.segments.slice();

        self.on('loadsegment', function(){
            var segment = allSegments.shift();
            var cb = function(data, err) {
                if(!self.peerFile) {
                    return
                }
                if(err) {
                    allSegments.push(segment);

                    self.emitError(err);
                    return;
                }

                util.log('PeerLoader. Load-segment callback', data, err);

                self.peerFile._setSegmentData(segment.i, data);

                util.log(self.peerFile);
                util.log(self.peerFile.getLoaderSegments());

                self.peer.updateSegments(self.peerFile.getLoaderSegments());

                if(allSegments.length == 0) {
                    util.log('PeerLoader. Load last segment');
                } else {
                    self.emit('loadsegment');
                }
            };

            var peers = this._getSegmentPeer(segment.id);
            if(!peers || peers.length == 0) {
                this._loadByHttp(segment, cb);
            } else {
                this._loadByPeer(segment, peers, cb);
            }
        });
        self.emit('loadsegment');
    });


};

PeerLoader.prototype._getPeer = function(peerId, cb) {
    var self = this;

    if(self.peerPool[peerId]) {
        if(self.peerPool[peerId].open) {
            cb(self.peerPool[peerId]);
        }
    } else {
        conn = self.peer.connect(peerId);
        conn.on('open', function() {
            self._addPeer(conn);
            cb(conn, null);
        });
        conn.on('error', function(err){
            err.type = 'segment-peer';
            cb(null, err);
        });
    }
};

PeerLoader.prototype._existsPeer = function(peerId) {
    var ret = false;
    if(this.peerPool[peerId] != undefined) {
        ret = true;
    }
    return ret;
};

PeerLoader.prototype._addPeer = function(conn) {
    var self = this;

    conn.on('data', function(message){
        var peerId = this.peer;
        var type = message.type;

        switch(type) {
            case 'SEGMENT-REQUEST':
                /*
                 {
                 type: 'SEGMENT-REQUEST',
                 segment: segmentId
                 }
                 */
                var segmentId = message.segment;
                var segmentData = self.peerFile._getSegmentData(segmentId);
                var msg = {
                    type: 'SEGMENT-ANSWER',
                    segment: segmentId
                };
                if(!segmentData) {
                    msg.error = 'No segment found';
                } else {
                    msg.data = segmentData;
                }

                conn.send(msg);
                break;
            case 'SEGMENT-ANSWER':
                /*
                 {
                 type: 'SEGMENT-ANSWER',
                 segment: segmentId,
                 error: 'Error text if exists',
                 data: 'segment data if exists'
                 }
                 */
                if(!self.requestQueue[peerId] || !self.requestQueue[peerId][message.segment]) {
                    return
                }

                if(message.error) {
                    var err = new Error(message.error);
                    err.type = 'segment-peer';

                    self.requestQueue[peerId][message.segment](null, err);
                } else {
                    self.requestQueue[peerId][message.segment](message.data, null);
                }
                delete(self.requestQueue[peerId][message.segment]);
                break;
        }
    });
    conn.on('error', function(error){
        var peerId = this.peer;
        if(self.requestQueue[peerId]) {
            var segments = Object.keys(self.requestQueue[peerId]);
            for(var i=0;i<segments.length; i ++) {
                var segmentId = segments[i];

                error.type = 'segment-peer';

                self.requestQueue[peerId][segmentId](null, error);
            }
        }
        self._removePeer(this);
    });
    conn.on('close', function() {
        var peerId = this.peer;
        if(self.requestQueue[peerId]) {
            var segments = Object.keys(self.requestQueue[peerId]);
            for(var i=0;i<segments.length; i ++) {
                var segmentId = segments[i];
                var err = new Error('Peer connection closed');
                err.type = 'segment-peer';

                self.requestQueue[peerId][segmentId](null, err);
            }
            delete(self.requestQueue[peerId]);
        }

        self._removePeer(this);
    });
    self.peerPool[conn.peer] = conn;
};

PeerLoader.prototype._removePeer = function(conn) {
    if(conn.open) {
        conn.close();
    }
    delete(this.requestQueue[conn.peer]);
    delete(this.peerPool[conn.peer]);
};

PeerLoader.prototype._updatePeers = function(peerList) {
    this.peerList = peerList;
    this.emit('updatepeers');
};

PeerLoader.prototype._updateSegments = function(segmentsList) {
    var tmp = {};
    var peers = Object.keys(segmentsList);
    for(var i=0; i<peers.length; i++) {
        var peerId = peers[i];
        var segments = segmentsList[peerId];

        if(segments.length > 0) {
            for(var j=0;j<segments.length;j++) {
                var segment = segments[j];

                if(!this.peerSegments[segment]) {
                    this.peerSegments[segment] = [peerId];
                } else if(this.peerSegments[segment].indexOf(peerId) == -1) {
                    this.peerSegments[segment].push(peerId);
                }
            }
        }
    }
    this.emit('updatesegments');
};

PeerLoader.prototype._getSegmentPeer = function (segmentId) {
    if(this.peerSegments[segmentId] == undefined || this.peerSegments[segmentId].length == 0) {
        return false;
    }
    return this.peerSegments[segmentId];
};

PeerLoader.prototype._loadByPeer = function(segment, peers, cb) {
    var self = this,
        segmentId = segment.id;

    peers.sort(function(){
       return Math.random()*Math.random();
    });

    var peerId = '';
    for(var i=0; i<peers.length; i++) {
        if(self._existsPeer(peers[i])) {
            peerId = peers[i];
            break;
        }
    }
    if(!peerId) {
        peerId = peers[0];
    }

    var message = {
        type: 'SEGMENT-REQUEST',
        segment: segmentId
    };

    if(self.requestQueue[peerId] == undefined) {
        self.requestQueue[peerId] = {};
    }
    self.requestQueue[peerId][segmentId] = cb;

    self._getPeer(peerId, function(conn, err){
        if(err != null) {
            throw err;
        }

        util.log('Create segment-request. Call peer send', message);

        conn.send(message);
        setTimeout(function(){
            if(self.requestQueue[peerId] != undefined && self.requestQueue[peerId][segmentId] != undefined) {
                var err = new Error('Segment request timeout');
                err.type = 'segment-peer';

                conn.emit('error', err);
            }
        }, 250);
    });
};

PeerLoader.prototype._loadByHttp = function(segment, cb) {
    var byteStart = segment.range[0],
        byteEnd = segment.range[1];

    var xhr = new XMLHttpRequest();
    xhr.responseType = 'arraybuffer';
    xhr.open('GET', this.peerFile.src, true);
    xhr.setRequestHeader('Range', 'bytes=' + byteStart + '-' + byteEnd);
    xhr.onload = function() {
        cb(xhr.response, null);
    };
    xhr.onerror = function() {
        var err = new Error('HTTP error. Status: ' + xhr.status + ' Message: ' + xhr.statusText);
        err.type = 'segment-http';

        cb(null, err);
    };
    xhr.send();
};

PeerLoader.prototype._abort = function(err) {
    this._aborted = true;

    if(err != undefined) {
        this.emitError(err);
    }
};

PeerLoader.prototype.emitError = function(type, err) {
    util.error('Error:', err);
    if (typeof err === 'string') {
        err = new Error(err);
    }
    err.type = type;
    this.emit('error', err);
};

module.exports = {
    PeerLoader: PeerLoader,
    PeerFile: PeerFile
};
