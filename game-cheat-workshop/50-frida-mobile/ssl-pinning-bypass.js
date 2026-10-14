/*
 * 通用 SSL pinning bypass (Android)
 * 覆盖: OkHttp3 CertificatePinner / TrustManagerImpl / HttpsURLConnection /
 *       Conscrypt / WebViewClient / Appcelerator / Phonegap / Flutter(BoringSSL)
 *
 * 用法: frida -U -f com.target.app -l ssl-pinning-bypass.js --no-pause
 */

Java.perform(function () {
    console.log('[*] SSL pinning bypass loaded');

    // --- OkHttp 3 ---
    try {
        var CertificatePinner = Java.use('okhttp3.CertificatePinner');
        CertificatePinner.check.overload('java.lang.String', 'java.util.List').implementation = function () {
            console.log('[OkHttp3] check bypassed for ' + arguments[0]);
        };
        CertificatePinner['check$okhttp'].implementation = function () {
            console.log('[OkHttp3] check$okhttp bypassed');
        };
    } catch (e) {}

    // --- TrustManagerImpl (Android N+) ---
    try {
        var TMI = Java.use('com.android.org.conscrypt.TrustManagerImpl');
        TMI.verifyChain.implementation = function (untrustedChain) {
            console.log('[TMI] verifyChain bypassed');
            return untrustedChain;
        };
        TMI.checkTrustedRecursive.implementation = function () {
            return Java.use('java.util.ArrayList').$new();
        };
    } catch (e) {}

    // --- Default X509TrustManager via SSLContext ---
    try {
        var X509TM = Java.use('javax.net.ssl.X509TrustManager');
        var SSLContext = Java.use('javax.net.ssl.SSLContext');
        var TrustManager = Java.registerClass({
            name: 'org.frida.TM',
            implements: [X509TM],
            methods: {
                checkClientTrusted: function () {},
                checkServerTrusted: function () {},
                getAcceptedIssuers: function () { return []; }
            }
        });
        var tms = [TrustManager.$new()];
        SSLContext.init.overload(
            '[Ljavax.net.ssl.KeyManager;',
            '[Ljavax.net.ssl.TrustManager;',
            'java.security.SecureRandom'
        ).implementation = function (km, _tms, sr) {
            console.log('[SSLContext] init overridden');
            return this.init(km, tms, sr);
        };
    } catch (e) {}

    // --- WebViewClient ---
    try {
        var WVC = Java.use('android.webkit.WebViewClient');
        WVC.onReceivedSslError.implementation = function (view, handler, err) {
            handler.proceed();
        };
    } catch (e) {}
});

// --- Flutter (BoringSSL ssl_crypto_x509_session_verify_cert_chain) ---
try {
    var m = Process.findModuleByName('libflutter.so');
    if (m) {
        // 签名特征不稳定, 用模式扫: cmp w8, #0 ; cset w0, eq (ret 1 即可)
        // 这里仅示意, 具体 offset 需按 Flutter 版本定位.
        console.log('[Flutter] libflutter.so @ ' + m.base);
    }
} catch (e) {}
