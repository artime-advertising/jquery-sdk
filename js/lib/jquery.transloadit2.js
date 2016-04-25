/*global tus:false*/

/** @license jquery.transloadit2.js: Copyright (c) 2013 Transloadit Ltd | MIT License: http://www.opensource.org/licenses/mit-license.php
 *
 * Fork this on Github: http://github.com/transloadit/jquery-sdk
 *
 * Transloadit servers allow browsers to cache jquery.transloadit2.js for 1 hour.
 * keep this in mind when rolling out fixes.
 */
require('../dep/json2')
require('../dep/jquery.jsonp')
require('../dep/toolbox.expose')
require('../dep/jquery.easing')
var uuid = require('uuid')
var isOnline = require('is-online');
var helpers = require('../dep/helpers')

!(function ($) {
  var PROTOCOL = (document.location.protocol === 'https:') ? 'https://' : 'http://'

  var DEFAULT_SERVICE = PROTOCOL + 'api2.transloadit.com/'

  var OPTIONS = {
    service: DEFAULT_SERVICE,
    assets: PROTOCOL + 'assets.transloadit.com/',
    beforeStart: function () { return true },
    onFileSelect: function () {},
    onStart: function () {},
    onProgress: function () {},
    onUpload: function () {},
    onResult: function () {},
    onCancel: function () {},
    onError: function () {},
    onSuccess: function () {},
    onDisconnect: function() {},
    onReconnect: function() {},
    resumable: false,
    resumableEndpointPath: '/resumable/',
    interval: 2500,
    pollTimeout: 8000,
    poll404Retries: 1500,
    pollConnectionRetries: 500,
    wait: false,
    processZeroFiles: true,
    triggerUploadOnFileSelection: false,
    autoSubmit: true,
    modal: true,
    exclude: '',
    fields: false,
    params: null,
    signature: null,
    region: 'us-east-1',
    debug: true,
    locale: 'en'
  }

  var I18N = {
    en: {
      'errors.BORED_INSTANCE_ERROR': 'Could not find a bored instance.',
      'errors.CONNECTION_ERROR': 'There was a problem connecting to the upload server',
      'errors.unknown': 'There was an internal error.',
      'errors.tryAgain': 'Please try your upload again.',
      'errors.troubleshootDetails': 'If you would like our help to troubleshoot this, ' +
          'please email us this information:',
      cancel: 'Cancel',
      details: 'Details',
      startingUpload: 'Starting upload ...',
      processingFiles: 'Upload done, now processing files ...',
      uploadProgress: '%s / %s MB at %s kB/s | %s left'
    },
    ja: {
      'errors.BORED_INSTANCE_ERROR': 'サーバー接続に問題があります',
      'errors.CONNECTION_ERROR': 'サーバー接続に問題があります',
      'errors.unknown': '通信環境に問題があります',
      'errors.tryAgain': 'しばらくしてから再度投稿してください',
      'errors.troubleshootDetails': '解決できない場合は、こちらにお問い合わせください ' +
          '下記の情報をメールでお送りください:',
      cancel: 'キャンセル',
      details: '詳細',
      startingUpload: '投稿中 ...',
      processingFiles: '接続中',
      uploadProgress: '%s MB / %s MB (%s kB / 秒)'
    }
  }
  var CSS_LOADED = false

  function sprintf (str, args) {
    args = args || []
    return str.replace(/(%[s])/g, function (m, i, s) {
      var arg = args.shift()
      if (!arg && arg !== 0) {
        return ''
      }
      return arg + ''
    })
  }

  $.fn.transloadit = function () {
    var args = Array.prototype.slice.call(arguments)
    var method
    var uploader
    var r

    if (this.length === 0) {
      return
    }

    if (this.length > 1) {
      this.each(function () {
        $.fn.transloadit.apply($(this), args)
      })
      return
    }

    if (args.length === 1 && typeof args[0] === 'object' || args[0] === undefined) {
      args.unshift('init')
    }

    method = args.shift()
    if (method === 'init') {
      uploader = new Uploader()
      args.unshift(this)
      this.data('transloadit.uploader', uploader)
    } else {
      uploader = this.data('transloadit.uploader')
    }

    if (!uploader) {
      throw new Error('Element is not initialized for transloadit!')
    }

    r = uploader[method].apply(uploader, args)
    return (r === undefined) ? this : r
  }

  $.fn.transloadit.i18n = I18N

  function Uploader () {
    this._assemblyId = null

    this._instance = null
    this._documentTitle = null
    this._timer = null
    this._options = {}
    this._uploads = []
    this._results = {}
    this._ended = null
    this._pollStarted = null
    this._pollRetries = 0
    this._started = false
    this._assembly = null
    this._params = null

    this._bytesReceivedBefore = 0

    this._$params = null
    this._$form = null
    this._$files = null
    this._$modal = null

    this._animatedTo100 = false
    this._lastUploadSpeedUpdateOn = 0
    this._fullyUploaded = false
    this._uploadRate = null
    this._durationLeft = null
    this._uploadFileIds = []
    this._resultFileIds = []
    this._xhr = null

    this._connectionCheckerInterval = null
    this._isOnline = true
    this._uploadIsInProgress = false
  }

  Uploader.prototype.init = function ($form, options) {
    this._initInternetConnectionChecker()

    this._$form = $form
    this.options($.extend({}, OPTIONS, options || {}))

    var self = this
    this._$form.bind('submit.transloadit', function () {
      self.validate()
      self._detectFileInputs()

      if (!self._options['processZeroFiles'] && self._$files.length === 0) {
        if (self._options.beforeStart()) {
          self.submitForm()
        }
      } else {
        if (self._options.beforeStart()) {
          self.start()
        }
      }

      return false
    })

    if (this._options['triggerUploadOnFileSelection']) {
      this._$form.on('change', 'input[type="file"]', function () {
        self._$form.trigger('submit.transloadit')
      })
    }

    this._$form.on('change', 'input[type="file"]', function () {
      self._options.onFileSelect($(this).val(), $(this))
    })

    this.includeCss()
  }

  Uploader.prototype.start = function () {
    this._xhr = null
    this._started = false
    this._ended = false
    this._bytesReceivedBefore = 0
    this._uploadRate = null
    this._durationLeft = null
    this._uploadIsInProgress = false
    this._lastUploadSpeedUpdateOn = 0
    this._fullyUploaded = false
    this._pollRetries = 0
    this._uploads = []
    this._animatedTo100 = false
    this._uploadFileIds = []
    this._resultFileIds = []
    this._results = {}

    var self = this
    var cb = function () {
      setTimeout(function () {
        self._poll()
      }, 300)
    }

    if (this._options.resumable) {
      return this._startWithResumabilitySupport(cb)
    }
    this._getInstance(function (err) {
      if (!err) {
        self._startWithXhr(cb)
      }
    })
  }

  Uploader.prototype._getInstance = function (cb) {
    var self = this

    this._instance = null
    var url = this._options['service']
    var attempts = 0

    function attempt () {
      $.jsonp({
        url: url,
        timeout: self._options.pollTimeout,
        callbackParameter: 'callback',
        success: function (result) {
          if (result.error) {
            return self._errorOut(result)
          }

          self._instance = result.hostname
          cb()
        },
        error: function (xhr, status, jsonpErr) {
          attempts++

          if (attempts < self._options.pollConnectionRetries) {
            return attempt()
          }

          var reason = 'JSONP assembly_id request status: ' + status
          reason += ', err: ' + jsonpErr

          var err = {
            error: 'CONNECTION_ERROR',
            message: self.i18n('errors.CONNECTION_ERROR'),
            reason: reason,
            url: url
          }
          self._errorOut(err)
          cb(err)
        }
      })
    }

    attempt()

    if (this._options.modal) {
      this.showModal()
    }
  }

  Uploader.prototype._startWithXhr = function (cb) {
    this._assemblyId = uuid.v4().replace(/\-/g, "")

    var self = this
    var formData = this._prepareFormData()
    this._appendFilteredFormFields(formData, true)
    this._appendCustomFormData(formData)

    var url = this._getAssemblyRequestTargetUrl()
    this._xhr = new XMLHttpRequest()

    this._xhr.addEventListener("loadstart", function() {
      self._uploadIsInProgress = true
    })
    this._xhr.addEventListener("error", function(err) {
      self._xhr = null
    })
    this._xhr.addEventListener("abort", function(err) {
      self._xhr = null
    })
    this._xhr.addEventListener("timeout", function(err) {
      self._xhr = null
    })

    this._xhr.addEventListener("load", function() {
      self._uploadIsInProgress = false
      self._fullyUploaded = true
    })
    this._xhr.upload.addEventListener("progress", function progressFunction(evt){
      if (!evt.lengthComputable) {
        return
      }
      self._renderProgress(evt.loaded, evt.total)
      self._options.onProgress(evt.loaded, evt.total, self._assembly)
    })

    this._xhr.open('POST', url)
    this._xhr.send(formData)
    cb()
  }

  Uploader.prototype._startWithResumabilitySupport = function (cb) {
    var self = this
    var formData = this._prepareFormData()
    this._appendTusFileCount(formData)
    this._appendFilteredFormFields(formData)
    this._appendCustomFormData(formData)

    function proceed () {
      var endpoint = PROTOCOL + self._instance + self._options.resumableEndpointPath

      self._$files.each(function () {
        var nameAttr = $(self).attr('name')
        for (var i = 0; i < self.files.length; i++) {
          var file = self.files[i]
          var upload = new tus.Upload(file, {
            endpoint: endpoint,
            resume: true,
            metadata: {
              fieldname: nameAttr,
              filename: file.name,
              assembly_id: self._assemblyId
            },
            onError: function (error) {
              console.log('Failed because: ' + error)
            },
            onProgress: function (bytesUploaded, bytesTotal) {
              self._renderProgress(bytesUploaded, bytesTotal)
              self._options.onProgress(bytesUploaded, bytesTotal, self._assembly)
            }
          })
          upload.start()
        }
      })
    }

    var url = this._options['service']
    var f = new XMLHttpRequest()
    f.open('POST', url)
    f.onreadystatechange = function () {
      if (f.readyState === 4 && f.status === 200) {
        var resp = JSON.parse(f.responseText)
        self._assemblyId = resp._assembly_id
        self._instance = resp._instance
        proceed()
      }
    }
    f.send(formData)
    cb()
  }

  Uploader.prototype._prepareFormData = function (form) {
    var assemblyParams = this._options.params
    if (this._$params) {
      assemblyParams = this._$params.val()
    }
    if (typeof assemblyParams !== 'string') {
      assemblyParams = JSON.stringify(assemblyParams)
    }

    var result = {}
    if (this._options.formData instanceof FormData) {
      result = this._options.formData
    } else {
      result = new FormData(form)
    }

    result.append('params', assemblyParams)
    if (this._options.signature) {
      result.append('signature', this._options.signature)
    }

    return result
  }

  Uploader.prototype._appendTusFileCount = function (formData) {
    var fileCount = 0
    this._$files.each(function () {
      fileCount += this.files.length
    })
    formData.append('tus_num_expected_upload_files', fileCount)
  }

  Uploader.prototype._appendFilteredFormFields = function (formData, allowFiles) {
    var $fields = this._getFilteredFormFields(allowFiles)

    $fields.each(function () {
      var name = $(this).attr('name')
      if (!name) {
        return
      }
      for (var i = 0; i < this.files.length; i++) {
        formData.append(name, this.files[i])
      }
    })
  }

  Uploader.prototype._appendCustomFormData = function (formData) {
    if (!this._options.formData) {
      return
    }

    for (var i = 0; i < this._options.formData.length; i++) {
      var tupel = this._options.formData[i]
      formData.append(tupel[0], tupel[1], tupel[2])
    }
  }

  Uploader.prototype._getAssemblyRequestTargetUrl = function () {
    var result = PROTOCOL + this._instance + '/assemblies/'
    result += this._assemblyId + '?redirect=false'
    return result
  }

  Uploader.prototype._getFilteredFormFields = function (allowFiles) {
    var fieldsFilter = '[name=params], [name=signature]'
    if (this._options.fields === true) {
      fieldsFilter = '*'
    } else if (typeof this._options.fields === 'string') {
      fieldsFilter += ', ' + this._options.fields
    } else {
      // fields is false, but let's attach file fields, otherwise we will not have uploads. :)
      if (allowFiles) {
        fieldsFilter += ", [type=file]"
      }
    }

    // Filter out submit elements right away as they will cause funny behavior
    // in the shadow form.
    var $fields = this._$form.find(':input[type!=submit]')
    if (!allowFiles) {
      $fields = $fields.filter('[type!=file]')
    }

    return $fields.filter(fieldsFilter)
  }

  Uploader.prototype.stop = function () {
    document.title = this._documentTitle
    this._ended = true
  }

  Uploader.prototype.cancel = function () {
    // @todo this has still a race condition if a new upload is started
    // while the cancel request is still being executed. Shouldn't happen
    // in real life, but needs fixing.

    if (!this._ended) {
      if (this._$params) {
        this._$params.prependTo(this._$form)
      }
      clearTimeout(this._timer)
      this._poll('?method=delete')
    }

    if (this._options.modal) {
      this.hideModal()
    }
  }

  Uploader.prototype.submitForm = function () {
    // prevent that files are uploaded to the final destination
    // after all that is what we use this plugin for :)
    if (this._$form.attr('enctype') === 'multipart/form-data') {
      this._$form.removeAttr('enctype')
    }

    if (this._assembly !== null) {
      $('<textarea/>')
        .attr('name', 'transloadit')
        .text(JSON.stringify(this._assembly))
        .prependTo(this._$form)
        .hide()
    }

    if (this._options.autoSubmit) {
      this._$form
        .unbind('submit.transloadit')
        .submit()
    }
  }

  Uploader.prototype.hideModal = function () {
    $.mask.close()
    this._$modal.remove()
    this._$modal = null
  }

  Uploader.prototype.showModal = function () {
    // Make sure to not show a second modal
    if (this._$modal) {
      return
    }

    this._$modal =
      $('<div id="transloadit">' +
        '<div class="content">' +
          '<a href="#close" class="close">' + this.i18n('cancel') + '</a>' +
          '<p class="status"></p>' +
          '<div class="progress progress-striped">' +
            '<div class="bar"><span class="percent"></span></div>' +
          '</div>' +
          '<label>' + this.i18n('startingUpload') + '</label>' +
          '<p class="error"></p>' +
          '<div class="error-details-toggle"><a href="#">' + this.i18n('details') + '</a></div>' +
          '<p class="error-details"></p>' +
        '</div>' +
      '</div>')
      .appendTo('body')

    $.extend(this._$modal, {
      '$content': this._$modal.find('.content'),
      '$close': this._$modal.find('.close'),
      '$label': this._$modal.find('label'),
      '$progress': this._$modal.find('.progress'),
      '$percent': this._$modal.find('.progress .percent'),
      '$progressBar': this._$modal.find('.progress .bar'),
      '$error': this._$modal.find('.error'),
      '$errorDetails': this._$modal.find('.error-details'),
      '$errorDetailsToggle': this._$modal.find('.error-details-toggle')
    })

    this._$modal.$error.hide()
    this._$modal.$errorDetails.hide()
    this._$modal.$errorDetailsToggle.hide()

    this._$modal.expose({
      api: true,
      maskId: 'transloadit_expose',
      opacity: 0.9,
      loadSpeed: 250,
      closeOnEsc: false,
      closeOnClick: false
    })

    var self = this
    this._$modal.$close.click(function () {
      self.cancel()
      return false
    })
  }

  Uploader.prototype.validate = function () {
    if (!this._options.params) {
      var $params = this._$form.find('input[name=params]')
      if (!$params.length) {
        alert('Could not find input[name=params] in your form.')
        return
      }

      this._$params = $params
      try {
        this._params = JSON.parse($params.val())
      } catch (e) {
        alert('Error: input[name=params] seems to contain invalid JSON.')
        return
      }
    } else {
      this._params = this._options.params
    }

    if (this._params.redirect_url) {
      this._$form.attr('action', this._params.redirect_url)
    } else if (this._options.autoSubmit && (this._$form.attr('action') === this._options.service + 'assemblies')) {
      alert('Error: input[name=params] does not include a redirect_url')
      return
    }
  }

  Uploader.prototype._poll = function (query) {
    var self = this
    if (this._ended) {
      return
    }

    // Reduce Firefox Title Flickering
    var match = /(mozilla)(?:.*? rv:([\w.]+))?/.exec(navigator.userAgent)
    var isMozilla = match && match[1]
    this._documentTitle = document.title
    if (isMozilla && !this._documentTitle) {
      document.title = 'Loading...'
    }

    var instance = 'status-' + this._instance
    var url = PROTOCOL + instance + '/assemblies/' + this._assemblyId

    if (query) {
      url += query
    }

    this._pollStarted = +new Date()

    $.jsonp({
      url: url,
      timeout: self._options.pollTimeout,
      callbackParameter: 'callback',
      success: function (assembly) {
        if (self._ended) {
          return
        }

        var continuePolling = self._handleSuccessfulPoll(assembly)
        if (continuePolling) {
          var timeout = self._calcPollTimeout()
          self._timer = setTimeout(function () {
            self._poll()
          }, timeout)
        }
      },
      error: function (xhr, status, jsonpErr) {
        if (self._ended) {
          return
        }

        var continuePolling = self._handleErroneousPoll(url, xhr, status, jsonpErr)
        if (continuePolling) {
          var timeout = self._calcPollTimeout()
          setTimeout(function () {
            self._poll()
          }, timeout)
        }
      }
    })
  }

  Uploader.prototype._handleSuccessfulPoll = function (assembly) {
    this._assembly = assembly

    if (assembly.error === 'ASSEMBLY_NOT_FOUND') {
      this._pollRetries++

      if (this._pollRetries > this._options.poll404Retries) {
        this._errorOut(assembly)
        return false
      }
      return true
    }

    if (assembly.error) {
      this._errorOut(assembly)
      return false
    }

    if (!this._started && assembly.bytes_expected > 0) {
      this._started = true
      this._options.onStart(assembly)
    }

    this._pollRetries = 0

    var isExecuting = assembly.ok === 'ASSEMBLY_EXECUTING'
    var isCanceled = assembly.ok === 'ASSEMBLY_CANCELED'
    var isComplete = assembly.ok === 'ASSEMBLY_COMPLETED'

    this._mergeUploads(assembly)
    this._mergeResults(assembly)

    if (isCanceled) {
      this._ended = true
      document.title = this._documentTitle
      this._options.onCancel(assembly)
      return false
    }

    if (isComplete || (!this._options['wait'] && isExecuting)) {
      this._ended = true
      document.title = this._documentTitle
      assembly.uploads = this._uploads
      assembly.results = this._results
      this._options.onSuccess(assembly)

      if (this._options.modal) {
        this.cancel()
      }
      this.submitForm()
      return false
    }

    return true
  }

  Uploader.prototype._handleErroneousPoll = function (url, xhr, status, jsonpErr) {
    this._pollRetries++
    if (this._pollRetries <= this._options.pollConnectionRetries) {
      return true
    }

    var reason = 'JSONP status poll request status: ' + status
    reason += ', err: ' + jsonpErr

    var err = {
      error: 'CONNECTION_ERROR',
      message: this.i18n('errors.CONNECTION_ERROR'),
      reason: reason,
      url: url
    }
    this._errorOut(err)
    return false
  }

  Uploader.prototype._renderError = function (err) {
    if (!this._options.modal) {
      return
    }

    if (!this._options.debug) {
      return this.cancel()
    }

    this._$modal.$content.addClass('content-error')
    this._$modal.$progress.hide()
    this._$modal.$label.hide()

    var errorMsg = err.error + ': ' + err.message + '<br /><br />'
    errorMsg += (err.reason || '')

    var errorsRequiringDetails = [
      'CONNECTION_ERROR',
      'BORED_INSTANCE_ERROR',
      'ASSEMBLY_NOT_FOUND'
    ]
    if ($.inArray(err.error, errorsRequiringDetails) === -1) {
      this._$modal.$error.html(errorMsg).show()
      return
    }

    var text = this.i18n('errors.unknown') + '<br/>' + this.i18n('errors.tryAgain')
    this._$modal.$error.html(text).show()

    var assemblyId = err._assemblyId ? err._assemblyId : this._assemblyId
    var self = this
    var ip = null

    $.getJSON(PROTOCOL + 'jsonip.com/', function (ipData) {
      ip = ipData.ip
    })
    .always(function () {
      var details = {
        endpoint: err.url,
        instance: self._instance,
        assembly_id: assemblyId,
        ip: ip,
        time: helpers._getUTCDatetime(),
        agent: navigator.userAgent,
        poll_retries: self._pollRetries,
        error: errorMsg
      }
      $.post(PROTOCOL + 'status.transloadit.com/client_error', details)

      var detailsArr = []
      for (var key in details) {
        detailsArr.push(key + ': ' + details[key])
      }

      var detailsTxt = self.i18n('errors.troubleshootDetails') + '<br /><br />'
      self._$modal.$errorDetails.hide().html(detailsTxt + detailsArr.join('<br />'))

      self._$modal.$errorDetailsToggle.show().find('a')
        .off('click')
        .on('click', function (e) {
          e.preventDefault()
          self._$modal.$errorDetails.toggle()
        })
    })
  }

  Uploader.prototype._detectFileInputs = function () {
    var $files = this._$form
      .find('input[type=file]')
      .not(this._options.exclude)

    if (!this._options['processZeroFiles']) {
      $files = $files.filter(function () {
        return this.value !== ''
      })
    }
    this._$files = $files
  }

  Uploader.prototype._renderProgress = function (received, expected) {
    if (!this._options.modal) {
      return
    }

    var progress = received / expected * 100
    if (progress > 100) {
      progress = 0
    }

    var timeSinceLastUploadSpeedUpdate = +new Date() - this._lastUploadSpeedUpdateOn
    var mbReceived = (received / 1024 / 1024).toFixed(2)
    var mbExpected = (expected / 1024 / 1024).toFixed(2)

    // Only update speed and remaining time every 1 second at most, otherwise the values
    // will fluctuate too much.
    var updateSpeed = timeSinceLastUploadSpeedUpdate >= 1000

    // We want to make sure we display "0s left" when the upload is done
    updateSpeed = updateSpeed || progress === 100

    var goingBackwards = this._bytesReceivedBefore && received < this._bytesReceivedBefore

    if (!this._animatedTo100 && updateSpeed) {
      var bytesReceived = received - this._bytesReceivedBefore
      var uploadRate = ((bytesReceived / 1024) / (timeSinceLastUploadSpeedUpdate / 1000)).toFixed(1)

      var outstanding = expected - received
      var speedInBytes = (bytesReceived / (timeSinceLastUploadSpeedUpdate / 1000)).toFixed(1)

      var durationLeft = ''
      if (speedInBytes > 0) {
        durationLeft = helpers._duration(outstanding / speedInBytes)
      }

      this._uploadRate = uploadRate
      this._durationLeft = durationLeft
      this._lastUploadSpeedUpdateOn = +new Date()
      this._bytesReceivedBefore = received
    }

    var txt = this.i18n('uploadProgress',
      mbReceived, mbExpected, this._uploadRate, this._durationLeft
    )
    this._$modal.$label.text(txt)

    var currentWidth = parseInt(this._$modal.$progress.css('width'), 10)
    var currPercent = this._$modal.$progressBar.data('percent')
    var self = this

    // if we are going backwards (due to a restart), do not animate, but reset the width
    // of the progress bar in one go
    if (currPercent > progress) {
      this._$modal.$progressBar.stop().css('width', progress + '%')
      this._$modal.$progressBar.data('percent', progress)
      this._setProgressbarPercent(progress)
      return
    }

    this._$modal.$progressBar.data('percent', progress)
    this._$modal.$progressBar.stop().animate(
      {width: progress + '%'},
      {
        duration: 1000,
        easing: 'linear',
        progress: function (promise, currPercent, remainingMs) {
          var percent = self._setProgressbarPercent(currentWidth)

          if (percent == 100 && !self._animatedTo100) {
            self._animatedTo100 = true
            setTimeout(function () {
              self._$modal.$label.text(self.i18n('processingFiles'))
              self._$modal.$progress.addClass('active')
              self._$modal.$percent.text('')
            }, 500)
          }
        }
      }
    )
  }

  Uploader.prototype._setProgressbarPercent = function (totalWidth) {
    var width = parseInt(this._$modal.$progressBar.css('width'), 10)

    var percent = (width * 100 / totalWidth).toFixed(0)
    if (percent > 100) {
      percent = 100
    }
    if (percent > 13 && !self._animatedTo100) {
      this._$modal.$percent.text(percent + '%')
    }
    if (percent <= 13) {
      this._$modal.$percent.text('')
    }

    return percent
  }

  Uploader.prototype.includeCss = function () {
    if (CSS_LOADED || !this._options.modal) {
      return
    }

    CSS_LOADED = true
    $('<link rel="stylesheet" type="text/css" href="' + this._options.assets + 'css/transloadit2-latest.css" />')
      .appendTo('head')
  }

  Uploader.prototype._calcPollTimeout = function () {
    var ping = this._pollStarted - +new Date()
    return ping < this._options.interval ? this._options.interval : ping
  }

  Uploader.prototype._mergeUploads = function (assembly) {
    for (var i = 0; i < assembly.uploads.length; i++) {
      var upload = assembly.uploads[i]

      if ($.inArray(upload.id, this._uploadFileIds) === -1) {
        this._options.onUpload(upload, assembly)
        this._uploads.push(upload)
        this._uploadFileIds.push(upload.id)
      }
    }
  }

  Uploader.prototype._mergeResults = function (assembly) {
    for (var step in assembly.results) {
      this._results[step] = this._results[step] || []

      for (var j = 0; j < assembly.results[step].length; j++) {
        var result = assembly.results[step][j]
        var resultId = step + '_' + result.id

        if ($.inArray(resultId, this._resultFileIds) === -1) {
          this._options.onResult(step, result, assembly)
          this._results[step].push(result)
          this._resultFileIds.push(resultId)
        }
      }
    }
  }

  Uploader.prototype._errorOut = function (err) {
    document.title = this._documentTitle
    this._ended = true
    this._renderError(err)
    this._options.onError(err)

    if (this._xhr && typeof this._xhr.abort === "function") {
      this._xhr.abort()
    }
  }

  Uploader.prototype._onDisconnect = function () {
    // display modal error message that the internet connection has disconnected
    // and that we retry the upload as soon as it comes back online
  }

  Uploader.prototype._onReconnect = function () {
    // If we had an upload in progress when we got the disconnect, retry it
    if (!this._uploadIsInProgress) {
      return
    }

    // Note: Google Chrome can resume xhr requests. However, we ignore this here, because
    // we have our own resume flag with tus support.
    if (this._xhr && typeof this._xhr.abort === 'function') {
      this._xhr.abort()
    }
    this.start()
  }

  Uploader.prototype._initInternetConnectionChecker = function () {
    if (this._connectionCheckerInterval) {
      return
    }

    var self = this
    this._connectionCheckerInterval = setInterval (function() {
      isOnline(function(online, a, b) {
        if (self._isOnline && !online) {
          self._onDisconnect()
          self._options.onDisconnect()
        }
        if (!self._isOnline && online) {
          self._onReconnect()
          self._options.onReconnect()
        }
        self._isOnline = online
      });
    }, 3000)
  }

  Uploader.prototype.options = function (options) {
    if (arguments.length === 0) {
      return this._options
    }

    $.extend(this._options, options)
  }

  Uploader.prototype.option = function (key, val) {
    if (arguments.length === 1) {
      return this._options[key]
    }

    this._options[key] = val
  }

  Uploader.prototype.i18n = function () {
    var args = Array.prototype.slice.call(arguments)
    var key = args.shift()
    var locale = this._options.locale
    var translated = I18N[locale] && I18N[locale][key] || I18N.en[key]
    if (!translated) {
      throw new Error('Unknown i18n key: ' + key)
    }

    return sprintf(translated, args)
  }
}(window.jQuery))
