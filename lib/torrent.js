module.exports = Torrent

var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var magnet = require('magnet-uri')
var parseTorrent = require('parse-torrent')
var Storage = require('./storage')
var Swarm = require('bittorrent-swarm')
var ut_metadata = require('ut_metadata')

var BLOCK_LENGTH = 16 * 1024
var MAX_BLOCK_LENGTH = 128 * 1024
var MAX_OUTSTANDING_REQUESTS = 5
var METADATA_BLOCK_LENGTH = 16 * 1024
var PIECE_TIMEOUT = 10000

inherits(Torrent, EventEmitter)

/**
 * A torrent
 *
 * @param {string|Buffer} torrentId   magnet uri, torrent file, or info hash
 * @param {Object} opts   options object
 */
function Torrent (torrentId, opts) {
  var self = this
  if (!(self instanceof Torrent)) return new Torrent(torrentId, opts)
  EventEmitter.call(self)

  if (typeof torrentId === 'string') {
    if (!/^magnet:/.test(torrentId) && torrentId.length === 40 || torrentId.length === 32) {
      // info hash (hex/base-32 string)
      torrentId = 'magnet:?xt=urn:btih:' + torrentId
    }
    // magnet uri
    var info = magnet(torrentId)
    if (!info.infoHash) {
      return self.emit('error', new Error('invalid torrent uri'))
    }
    self.infoHash = info.infoHash
    self.name = info.name
  } else if (Buffer.isBuffer(torrentId)) {
    if (torrentId.length === 20) {
      // info hash (buffer)
      self.infoHash = torrentId.toString('hex')
    } else {
      // torrent file
      self._onMetadata(torrentId)
    }
  }

  self.peerId = opts.peerId
  self.torrentPort = opts.torrentPort
  self.dhtPort = opts.dhtPort

  self.files = []
  self.metadata = null
  self.parsedTorrent = null
  self.storage = null

  self.swarm = new Swarm(self.infoHash, self.peerId, {
    handshake: { dht: true }
  })

  if (self.torrentPort) {
    self.swarm.listen(self.torrentPort, function (port) {
      self.emit('listening', port)
    })
  }

  self.swarm.on('error', function (err) {
    self.emit('error', err)
  })

  self.swarm.on('wire', self._onWire.bind(self))
}

/**
 * Torrent size (in bytes)
 */
Object.defineProperty(Torrent.prototype, 'length', {
  get: function () {
    var self = this
    if (!self.parsedTorrent) return 0
    return self.parsedTorrent.length
  }
})

/**
 * Time remaining (in milliseconds)
 */
Object.defineProperty(Torrent.prototype, 'timeRemaining', {
  get: function () {
    var self = this
    var remainingBytes = self.length - self.downloaded
    if (self.swarm.downloadSpeed() === 0) return Infinity
    return (remainingBytes / self.swarm.downloadSpeed()) * 1000
  }
})

/**
 * Percentage complete, represented as a number between 0 and 1
 */
Object.defineProperty(Torrent.prototype, 'progress', {
  get: function () {
    var self = this
    if (!self.parsedTorrent) return 0
    return self.downloaded / self.parsedTorrent.length
  }
})

/**
 * Bytes downloaded (and verified)
 */
Object.defineProperty(Torrent.prototype, 'downloaded', {
  get: function () {
    var self = this
    return (self.storage && self.storage.downloaded) || 0
  }
})

/**
 * Bytes uploaded
 */
Object.defineProperty(Torrent.prototype, 'uploaded', {
  get: function () {
    var self = this
    return self.swarm.uploaded
  }
})

/**
 * Ratio of bytes downloaded to uploaded
 */
Object.defineProperty(Torrent.prototype, 'ratio', {
  get: function () {
    var self = this
    if (self.uploaded === 0) return 0
    return self.downloaded / self.uploaded
  }
})

/**
 * Destroy and cleanup this torrent.
 */
Torrent.prototype.destroy = function (cb) {
  var self = this
  self.swarm.destroy(cb)
}

/**
 * Add a peer to the swarm
 * @param {string} addr
 */
Torrent.prototype.addPeer = function (addr) {
  var self = this
  self.swarm.add(addr)
}

//
// HELPER METHODS
//

Torrent.prototype._onWire = function (wire) {
  var self = this

  wire.use(ut_metadata(self.metadata))

  if (!self.metadata) {
    wire.ut_metadata.on('metadata', function (metadata) {
      self._onMetadata(metadata)
    })
    wire.ut_metadata.fetch()
  }

  // Send KEEP-ALIVE (every 60s) so peers will not disconnect the wire
  wire.setKeepAlive(true)

  // If peer supports DHT, send PORT message to report DHT node listening port
  if (wire.peerExtensions.dht && self.dhtPort) {
    console.log(wire.remoteAddress, 'supports DHT')
    wire.port(self.dhtPort)
  }

  // When peer sends PORT, add them to the routing table
  wire.on('port', function (port) {
    console.log(wire.remoteAddress, 'port', port)
    // TODO: DHT doesn't have a routing table yet
    // dht.add(wire.remoteAddress, port)
  })

  // Timeout for piece requests to this peer
  wire.setTimeout(PIECE_TIMEOUT)

  if (self.metadata) {
    self._onWireWithMetadata(wire)
  }
}

Torrent.prototype._onWireWithMetadata = function (wire) {
  var self = this

  function requestPiece (index) {
    var len = wire.requests.length
    if (len >= MAX_OUTSTANDING_REQUESTS) return

    var endGame = (len === 0 && self.storage.numMissing < 30)
    var block = self.storage.selectBlock(index, endGame)
    if (!block) {
      // no blocks need to be downloaded in this piece
      return
    }

    console.log(wire.remoteAddress, 'requestPiece', index, 'offset', block.offset, 'length', block.length)
    wire.request(index, block.offset, block.length, function (err, buffer) {
      if (err)
        return self.storage.deselectBlock(index, block.offset)

      self.storage.writeBlock(index, block.offset, buffer)
      requestPieces()
    })
  }

  function requestPieces () {
    for (var index = 0, len = wire.peerPieces.length; index < len; index++) {
      if (wire.peerPieces[index] && self.storage.pieces[index]) {
        // if peer has this piece AND it's a valid piece, then request blocks
        requestPiece(index)
      }
    }
  }

  wire.on('have', function (index) {
    if (wire.peerChoking || !self.storage.pieces[index])
      return
    requestPiece(index)
  });

  wire.on('unchoke', requestPieces)

  wire.once('interested', function () {
    wire.unchoke()
  })

  wire.on('request', function (index, offset, length, cb) {
    // Disconnect from peers that request more than 128KB, per spec
    if (length > MAX_BLOCK_LENGTH) {
      console.error(wire.remoteAddress, 'requested invalid block size', length)
      return wire.destroy()
    }

    process.nextTick(function () {
      var block = self.storage.readBlock(index, offset, length)
      if (!block) return cb(new Error('requested block not available'))
      cb(null, block)
    })
  })

  wire.bitfield(self.storage.bitfield) // always send bitfield (required)
  wire.interested() // always start out interested
}

Torrent.prototype._onMetadata = function (metadata) {
  var self = this

  if (self.metadata) {
    return
  }

  self.metadata = metadata
  try {
    self.parsedTorrent = parseTorrent(self.metadata)
  } catch (err) {
    return self.emit('error', err)
  }

  self.name = self.parsedTorrent.name
  self.infoHash = self.parsedTorrent.infoHash

  self.storage = new Storage(self.parsedTorrent)
  self.storage.on('piece', self._onStoragePiece.bind(self))
  self.storage.on('file', function (file) {
    // TODO: do something smarter
    console.log('FILE', file.name)
  })
  self.storage.on('done', function () {
    // TODO: do soemthing smarter
    console.log('done with torrent!')
  })

  self.storage.files.forEach(function (file) {
    self.files.push(file)
  })

  if (self.swarm) {
    self.swarm.wires.forEach(function (wire) {
      self._onWireWithMetadata(wire)
    })
  }

  self.emit('metadata')
}

/**
 * When a piece is fully downloaded, notify all peers with a HAVE message.
 * @param  {Piece} piece
 */
Torrent.prototype._onStoragePiece = function (piece) {
  var self = this
  console.log('PIECE', piece.index)
  self.swarm.wires.forEach(function (wire) {
    wire.have(piece.index)
  })
}
