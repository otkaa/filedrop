import 'dart:convert';
import 'dart:typed_data';
import 'package:basic_utils/basic_utils.dart';
import 'package:crypto/crypto.dart';

class TlsCert {
  final String certPem;
  final String keyPem;
  final String fingerprint; // sha256 of DER, lowercase hex (matches desktop)
  TlsCert(this.certPem, this.keyPem, this.fingerprint);
}

/// Generate a fresh self-signed RSA cert. Persisted by the caller so the
/// fingerprint stays stable (peers pin it).
TlsCert generateCert(String deviceName) {
  final pair = CryptoUtils.generateRSAKeyPair(keySize: 2048);
  final priv = pair.privateKey as RSAPrivateKey;
  final pub = pair.publicKey as RSAPublicKey;
  final dn = {'CN': 'filedrop-${_san(deviceName)}'};
  final csr = X509Utils.generateRsaCsrPem(dn, priv, pub);
  final certPem = X509Utils.generateSelfSignedCertificate(priv, csr, 3650);
  final keyPem = CryptoUtils.encodeRSAPrivateKeyToPem(priv);
  return TlsCert(certPem, keyPem, fingerprintOfPem(certPem));
}

String fingerprintOfPem(String certPem) => fingerprintOfDer(_pemToDer(certPem));

String fingerprintOfDer(List<int> der) => sha256.convert(der).toString();

Uint8List _pemToDer(String pem) {
  final b64 = pem
      .replaceAll('-----BEGIN CERTIFICATE-----', '')
      .replaceAll('-----END CERTIFICATE-----', '')
      .replaceAll(RegExp(r'\s'), '');
  return base64.decode(b64);
}

String _san(String name) {
  final s = name.replaceAll(RegExp(r'[^a-zA-Z0-9_-]'), '');
  return s.isEmpty ? 'device' : (s.length > 32 ? s.substring(0, 32) : s);
}
