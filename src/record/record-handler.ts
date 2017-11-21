import {
  TOPIC,
  PARSER_ACTIONS,
  RECORD_ACTIONS as RA,
  RecordMessage,
  RecordWriteMessage,
  ListenMessage,
} from '../constants'
import ListenerRegistry from '../listen/listener-registry'
import SubscriptionRegistry from '../utils/subscription-registry'
import RecordDeletion from './record-deletion'
import recordRequest from './record-request'
import RecordTransition from './record-transition'
import { isExcluded } from '../utils/utils'

const WRITE_ACK_TO_ACTION: { [key: number]: RA } = {
  [RA.CREATEANDPATCH_WITH_WRITE_ACK]: RA.CREATEANDPATCH,
  [RA.CREATEANDUPDATE_WITH_WRITE_ACK]: RA.CREATEANDUPDATE,
  [RA.PATCH_WITH_WRITE_ACK]: RA.PATCH,
  [RA.UPDATE_WITH_WRITE_ACK]: RA.UPDATE,
  [RA.ERASE_WITH_WRITE_ACK]: RA.ERASE,
}

export default class RecordHandler {
  private metaData: any
  private config: DeepstreamConfig
  private services: DeepstreamServices
  private subscriptionRegistry: SubscriptionRegistry
  private listenerRegistry: ListenerRegistry
  private transitions: any
  private recordRequestsInProgress: any
/**
 * The entry point for record related operations
 */
  constructor (config: DeepstreamConfig, services: DeepstreamServices, subscriptionRegistry?: SubscriptionRegistry, listenerRegistry?: ListenerRegistry, metaData?: any) {
    this.metaData = metaData
    this.config = config
    this.services = services
    this.subscriptionRegistry =
    subscriptionRegistry || new SubscriptionRegistry(config, services, TOPIC.RECORD, TOPIC.RECORD_SUBSCRIPTIONS)
    this.listenerRegistry =
    listenerRegistry || new ListenerRegistry(TOPIC.RECORD, config, services, this.subscriptionRegistry, null)
    this.subscriptionRegistry.setSubscriptionListener(this.listenerRegistry)
    this.transitions = {}
    this.recordRequestsInProgress = {}
  }

/**
 * Handles incoming record requests.
 *
 * Please note that neither CREATE nor READ is supported as a
 * client send action. Instead the client sends CREATEORREAD
 * and deepstream works which one it will be
 */
  public handle (socketWrapper: SocketWrapper, message: RecordMessage): void {
    const action = message.isWriteAck ? WRITE_ACK_TO_ACTION[message.action] : message.action
    if (action === RA.SUBSCRIBECREATEANDREAD) {
    /*
     * Return the record's contents and subscribes for future updates.
     * Creates the record if it doesn't exist
     */
      this.createOrRead(socketWrapper, message)
    } else if (
      action === RA.CREATEANDUPDATE ||
      action === RA.CREATEANDPATCH
    ) {
    /*
     * Allows updates to the record without being subscribed, creates
     * the record if it doesn't exist
     */
      this.createAndUpdate(socketWrapper, message as RecordWriteMessage)
    } else if (action === RA.READ) {
    /*
     * Return the current state of the record in cache or db
     */
      this.snapshot(socketWrapper, message)
    } else if (action === RA.HEAD) {
    /*
     * Return the current version of the record or -1 if not found
     */
      this.head(socketWrapper, message)
    } else if (action === RA.SUBSCRIBEANDHEAD) {
    /*
     * Return the current version of the record or -1 if not found, subscribing either way
     */
      this.subscribeAndHead(socketWrapper, message)
    } else if (action === RA.UPDATE || action === RA.PATCH || action === RA.ERASE) {
    /*
     * Handle complete (UPDATE) or partial (PATCH/ERASE) updates
     */
      this.update(socketWrapper, message as RecordWriteMessage, message.isWriteAck || false)
    } else if (action === RA.DELETE) {
    /*
     * Deletes the record
     */
      this.delete(socketWrapper, message)
    } else if (action === RA.DELETE_SUCCESS) {
    /*
     * Handle delete acknowledgement from message bus
     * TODO: Different action
     */
      this.remoteDelete(socketWrapper, message)
    } else if (action === RA.UNSUBSCRIBE) {
  /*
   * Unsubscribes (discards) a record that was previously subscribed to
   * using read()
   */
      this.subscriptionRegistry.unsubscribe(message, socketWrapper)
    } else if (action === RA.LISTEN ||
  /*
   * Listen to requests for a particular record or records
   * whose names match a pattern
   */
    action === RA.UNLISTEN ||
    action === RA.LISTEN_ACCEPT ||
    action === RA.LISTEN_REJECT) {
      this.listenerRegistry.handle(socketWrapper, message as ListenMessage)
    } else {
      this.services.logger.error(PARSER_ACTIONS[PARSER_ACTIONS.UNKNOWN_ACTION], RA[action], this.metaData)
    }
  }

/**
 * Sends the records data current data once loaded from the cache, and null otherwise
 */
  private snapshot (socketWrapper: SocketWrapper, message: RecordMessage): void {
    const onComplete = function (record, recordName, socket: SocketWrapper) {
      if (record) {
        sendRecord(recordName, record, socket)
      } else {
        socket.sendMessage({
          topic: TOPIC.RECORD,
          action: RA.RECORD_NOT_FOUND,
          originalAction: message.action,
          name: message.name
        })
      }
    }
    const onError = (event: RA, errorMessage, recordName, socket: SocketWrapper) => {
      socket.sendMessage({
        topic: TOPIC.RECORD,
        action: event,
        originalAction: message.action,
        name: recordName
      })
    }

    recordRequest(
      message.name,
      this.config,
      this.services,
      socketWrapper,
      onComplete,
      onError,
      this,
      this.metaData,
    )
  }

  /**
   * Returns just the current version number of a record
   * Results in a HEAD_RESPONSE
   * If the record is not found, the version number will be -1
   */
  private head (socketWrapper: SocketWrapper, message: RecordMessage): void {
    const onComplete = function (record) {
      socketWrapper.sendMessage({
        topic: TOPIC.RECORD,
        action: RA.HEAD_RESPONSE,
        name: message.name,
        version: record ? record._v : -1,
      })
    }

    const onError = (event: RA, errorMessage, recordName, socket: SocketWrapper) => {
      socket.sendMessage({
        topic: TOPIC.RECORD,
        action: event,
        originalAction: message.action,
        name: recordName
      })
    }

    recordRequest(
      message.name,
      this.config,
      this.services,
      socketWrapper,
      onComplete,
      onError,
      this,
      this.metaData,
    )
  }

  /**
   * Same as head, and also subscribes the client to record updates.
   * Always results in SUBSCRIBE_ACK
   */
  private subscribeAndHead (socketWrapper: SocketWrapper, message: RecordMessage): void {
    this.head(socketWrapper, message)
    this.subscriptionRegistry.subscribe(
      Object.assign({}, message, { action: RA.SUBSCRIBE }),
      socketWrapper
    )
  }

/**
 * Tries to retrieve the record and creates it if it doesn't exist. Please
 * note that create also triggers a read once done
 */
  private createOrRead (socketWrapper: SocketWrapper, message: RecordMessage): void {
    const onComplete = function (record, recordName, socket) {
      if (record) {
        this.readAndSubscribe(message, record, socket)
      } else {
        this.permissionAction(
          RA.CREATE,
          message,
          message.action,
          socket,
          this.create.bind(this, message, socket),
        )
      }
    }

    recordRequest(
      message.name,
      this.config,
      this.services,
      socketWrapper,
      onComplete,
      () => {},
      this,
      this.metaData,
    )
  }

/**
 * An upsert operation where the record will be created and written to
 * with the data in the message. Important to note that each operation,
 * the create and the write are permissioned separately.
 *
 * This method also takes note of the storageHotPathPatterns option, when a record
 * with a name that matches one of the storageHotPathPatterns is written to with
 * the CREATEANDUPDATE action, it will be permissioned for both CREATE and UPDATE, then
 * inserted into the cache and storage.
 */
  private createAndUpdate (socketWrapper: SocketWrapper, message: RecordWriteMessage): void {
    const recordName = message.name
    const isPatch = message.path !== undefined
    const originalAction = message.action
    Object.assign(message, { action: isPatch ? RA.PATCH : RA.UPDATE })

    // allow writes on the hot path to bypass the record transition
    // and be written directly to cache and storage
    for (let i = 0; i < this.config.storageHotPathPrefixes.length; i++) {
      const pattern = this.config.storageHotPathPrefixes[i]
      if (recordName.indexOf(pattern) !== -1 && !isPatch) {
        this.permissionAction(RA.CREATE, message, originalAction, socketWrapper, () => {
          this.permissionAction(RA.UPDATE, message, originalAction, socketWrapper, () => {
            this.forceWrite(recordName, message, socketWrapper)
          })
        })
        return
      } else if (isPatch) {
        socketWrapper.sendMessage({
          topic: TOPIC.RECORD,
          action: RA.INVALID_PATCH_ON_HOTPATH,
          originalAction: message.action,
          name: recordName
        })
        return
      }
    }

    const transition = this.transitions[recordName]
    if (transition) {
      this.permissionAction(message.action, message, originalAction, socketWrapper, () => {
        transition.add(socketWrapper, message)
      })
      return
    }

    this.permissionAction(RA.CREATE, message, originalAction, socketWrapper, () => {
      this.permissionAction(RA.UPDATE, message, originalAction, socketWrapper, () => {
        this.update(socketWrapper, message, true)
      })
    })
  }

/**
 * Forcibly writes to the cache and storage layers without going via
 * the RecordTransition. Usually updates and patches will go via the
 * transition which handles write acknowledgements, however in the
 * case of a hot path write acknowledgement we need to handle that
 * case here.
 */
  private forceWrite (recordName: string, message: RecordWriteMessage, socketWrapper: SocketWrapper): void {
    socketWrapper.parseData(message)
    const record = { _v: 0, _d: message.parsedData }
    const writeAck = message.isWriteAck
    let cacheResponse = false
    let storageResponse = false
    let writeError
    this.services.storage.set(recordName, record, error => {
      if (writeAck) {
        storageResponse = true
        writeError = writeError || error || null
        this.handleForceWriteAcknowledgement(
          socketWrapper, message, cacheResponse, storageResponse, writeError,
        )
      }
    }, this.metaData)

    this.services.cache.set(recordName, record, error => {
      if (!error) {
        this.broadcastUpdate(recordName, message, false, socketWrapper)
      }
      if (writeAck) {
        cacheResponse = true
        writeError = writeError || error || null
        this.handleForceWriteAcknowledgement(
        socketWrapper, message, cacheResponse, storageResponse, writeError,
      )
      }
    }, this.metaData)
  }

/**
 * Handles write acknowledgements during a force write. Usually
 * this case is handled via the record transition.
 */
  public handleForceWriteAcknowledgement (
    socketWrapper: SocketWrapper, message: RecordWriteMessage, cacheResponse: boolean, storageResponse: boolean, error: Error,
  ): void {
    if (storageResponse && cacheResponse) {
      socketWrapper.sendMessage({
        topic: TOPIC.RECORD,
        action: RA.WRITE_ACKNOWLEDGEMENT,
        name: message.name,
        parsedData: [message.version, error],
      }, true)
    }
  }

/**
 * Creates a new, empty record and triggers a read operation once done
 */
  private create (message: RecordMessage, socketWrapper: SocketWrapper, callback: Function): void {
    const recordName = message.name
    const record = { _v: 0, _d: {} }

    // store the records data in the cache and wait for the result
    this.services.cache.set(recordName, record, error => {
      if (error) {
        this.services.logger.error(RA[RA.RECORD_CREATE_ERROR], recordName, this.metaData)
        socketWrapper.sendMessage({
          topic: TOPIC.RECORD,
          action: RA.RECORD_CREATE_ERROR,
          originalAction: message.action,
          name: message.name
        })
      } else if (callback) {
        callback(recordName, socketWrapper)
      } else {
        this.readAndSubscribe(message, record, socketWrapper)
      }
    }, this.metaData)

    if (!isExcluded(this.config.storageExclusionPrefixes, message.name)) {
    // store the record data in the persistant storage independently and don't wait for the result
      this.services.storage.set(recordName, record, error => {
        if (error) {
          this.services.logger.error(RA[RA.RECORD_CREATE_ERROR], `storage:${error}`, this.metaData)
        }
      }, this.metaData)
    }
  }

/**
 * Subscribes to updates for a record and sends its current data once done
 */
  private readAndSubscribe (message: RecordMessage, record: StorageRecord, socketWrapper: SocketWrapper): void {
    this.permissionAction(RA.READ, message, message.action, socketWrapper, () => {
      this.subscriptionRegistry.subscribe(Object.assign({}, message, { action: RA.SUBSCRIBE }), socketWrapper)
      sendRecord(message.name, record, socketWrapper)
    })
  }

 /**
 * Applies both full and partial updates. Creates a new record transition that will live as
 * long as updates are in flight and new updates come in
 */
  private update (socketWrapper: SocketWrapper, message: RecordWriteMessage, upsert: boolean): void {
    const recordName = message.name
    const version = message.version
    const isPatch = message.path !== undefined
    Object.assign(message, { action: isPatch ? RA.PATCH : RA.UPDATE })

  /*
   * If the update message is received from the message bus, rather than from a client,
   * assume that the original deepstream node has already updated the record in cache and
   * storage and only broadcast the message to subscribers
   */
    if (socketWrapper.isRemote) {
      this.broadcastUpdate(recordName, message, false, socketWrapper)
      return
    }

    let transition = this.transitions[recordName]
    if (transition && transition.hasVersion(version)) {
      transition.sendVersionExists({ message, version, sender: socketWrapper })
      return
    }

    if (!transition) {
      transition = new RecordTransition(recordName, this.config, this.services, this, this.metaData)
      this.transitions[recordName] = transition
    }

    transition.add(socketWrapper, message, upsert)
  }

/**
 * Invoked by RecordTransition. Notifies local subscribers and other deepstream
 * instances of record updates
 */
  public broadcastUpdate (name: string, message: RecordMessage, noDelay: boolean, originalSender: SocketWrapper): void {
    this.subscriptionRegistry.sendToSubscribers(name, message, noDelay, originalSender)
  }

/**
 * Called by a RecordTransition, either if it is complete or if an error occured. Removes
 * the transition from the registry
 */
  public transitionComplete (recordName: string): void {
    delete this.transitions[recordName]
  }

/**
 * Executes or schedules a callback function once all transitions are complete
 *
 * This is called from the PermissionHandler destroy method, which
 * could occur in cases where 'runWhenRecordStable' is never called,
 * such as when no cross referencing or data loading is used.
 */
  public removeRecordRequest (recordName: string): void {
    if (!this.recordRequestsInProgress[recordName]) {
      return
    }

    if (this.recordRequestsInProgress[recordName].length === 0) {
      delete this.recordRequestsInProgress[recordName]
      return
    }

    const callback = this.recordRequestsInProgress[recordName].splice(0, 1)[0]
    callback(recordName)
  }

/**
 * Executes or schedules a callback function once all record requests are removed.
 * This is critical to block reads until writes have occured for a record, which is
 * only from permissions when a rule is required to be run and the cache has not
 * verified it has the latest version
 */
  public runWhenRecordStable (recordName: string, callback: Function): void {
    if (
    !this.recordRequestsInProgress[recordName] ||
    this.recordRequestsInProgress[recordName].length === 0
  ) {
      this.recordRequestsInProgress[recordName] = []
      callback(recordName)
    } else {
      this.recordRequestsInProgress[recordName].push(callback)
    }
  }

/**
 * Deletes a record. If a transition is in progress it will be stopped. Once the deletion is
 * complete, an ACK is returned to the sender and broadcast to the message bus.
 */
  private delete (socketWrapper: SocketWrapper, message: RecordMessage) {
    const recordName = message.name

    if (this.transitions[recordName]) {
      this.transitions[recordName].destroy()
      delete this.transitions[recordName]
    }

    // tslint:disable-next-line
    new RecordDeletion(this.config, this.services, socketWrapper, message, this.onDeleted.bind(this), this.metaData)
  }

/**
 * Handle a remote record deletion from the message bus. We assume that the original deepstream node
 * has already deleted the record from cache and storage and we only need to broadcast the message
 * to subscribers.
 *
 * If a transition is in progress it will be stopped.
 */
  private remoteDelete (socketWrapper: SocketWrapper, message: RecordMessage) {
    const recordName = message.name

    if (this.transitions[recordName]) {
      this.transitions[recordName].destroy()
      delete this.transitions[recordName]
    }

    this.onDeleted(recordName, message, socketWrapper)
  }

/*
 * Callback for completed deletions. Notifies subscribers of the delete and unsubscribes them
 */
  private onDeleted (name: string, message: RecordMessage, originalSender: SocketWrapper) {
    this.broadcastUpdate(name, message, true, originalSender)

    for (const subscriber of this.subscriptionRegistry.getLocalSubscribers(name)) {
      this.subscriptionRegistry.unsubscribe(message, subscriber, true)
    }
  }

/**
 * A secondary permissioning step that is performed once we know if the record exists (READ)
 * or if it should be created (CREATE)
 */
  private permissionAction (actionToPermission: RA, message: Message, originalAction: RA, socketWrapper: SocketWrapper, successCallback: Function) {
    const copyWithAction = Object.assign({}, message, { action: actionToPermission })
    this.services.permissionHandler.canPerformAction(
      socketWrapper.user,
      copyWithAction,
      onPermissionResponse.bind(this, socketWrapper, message, originalAction, successCallback),
      socketWrapper.authData,
      socketWrapper,
    )
  }

}

/*
 * Callback for complete permissions. Important to note that only compound operations like
 * CREATE_AND_UPDATE will end up here.
 */
function onPermissionResponse (
  socketWrapper: SocketWrapper, message: RecordMessage, originalAction: RA, successCallback: Function, error: Error, canPerformAction: boolean,
): void {
  if (error || !canPerformAction) {
    let action
    if (error) {
      this.services.logger.error(RA[RA.MESSAGE_PERMISSION_ERROR], error.toString())
      action = RA.MESSAGE_PERMISSION_ERROR
    } else {
      action = RA.MESSAGE_DENIED
    }
    const msg = {
      topic: TOPIC.RECORD,
      action,
      originalAction,
      name: message.name
    } as RecordMessage
    if (message.correlationId) {
      msg.correlationId = message.correlationId
    }
    socketWrapper.sendMessage(msg)
  } else {
    successCallback()
  }
}

  /**
 * Sends the records data current data once done
 */
function sendRecord (recordName: string, record: StorageRecord, socketWrapper: SocketWrapper) {
  socketWrapper.sendMessage({
    topic: TOPIC.RECORD,
    action: RA.READ_RESPONSE,
    name: recordName,
    version: record._v,
    parsedData: record._d,
  })
}
