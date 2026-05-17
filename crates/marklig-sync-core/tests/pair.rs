use marklig_sync_core::pair::{
    HandshakeInitiator, HandshakeResponder, PairId, QrPayload,
};

/// Generate a Noise-compatible X25519 static keypair via snow's own helper
/// so test vectors don't depend on a specific rand crate version.
fn generate_static_keypair() -> ([u8; 32], [u8; 32]) {
    let builder = snow::Builder::new(
        "Noise_XK_25519_ChaChaPoly_BLAKE2s"
            .parse()
            .expect("Noise XK pattern parses"),
    );
    let kp = builder.generate_keypair().unwrap();
    let mut priv_arr = [0u8; 32];
    let mut pub_arr = [0u8; 32];
    priv_arr.copy_from_slice(&kp.private);
    pub_arr.copy_from_slice(&kp.public);
    (priv_arr, pub_arr)
}

#[test]
fn handshake_roundtrip_yields_equal_pair_keys_and_ids() {
    let (init_priv, _init_pub) = generate_static_keypair();
    let (resp_priv, resp_pub) = generate_static_keypair();

    let mut initiator = HandshakeInitiator::new(&init_priv, &resp_pub).unwrap();
    let mut responder = HandshakeResponder::new(&resp_priv).unwrap();

    // Noise XK is a 3-message handshake: e / e, ee, s, es / s, se.
    let mut buf = Vec::new();
    initiator.write_message(&mut buf).unwrap();
    responder.read_message(&buf).unwrap();
    buf.clear();
    responder.write_message(&mut buf).unwrap();
    initiator.read_message(&buf).unwrap();
    buf.clear();
    initiator.write_message(&mut buf).unwrap();
    responder.read_message(&buf).unwrap();

    let it = initiator.finish().unwrap();
    let rt = responder.finish().unwrap();
    assert_eq!(it.pair_key, rt.pair_key);
    assert_eq!(it.pair_id, rt.pair_id);
}

#[test]
fn handshake_with_wrong_responder_pubkey_fails_to_finish() {
    let (init_priv, _) = generate_static_keypair();
    let (_resp_priv, _resp_pub) = generate_static_keypair();
    let (fake_resp_priv, _wrong_pub) = generate_static_keypair();

    // Initiator uses the right pubkey; responder side uses a different
    // private key — read_message should fail on the second exchange.
    let (_, real_pub) = generate_static_keypair();
    let mut initiator = HandshakeInitiator::new(&init_priv, &real_pub).unwrap();
    let mut responder = HandshakeResponder::new(&fake_resp_priv).unwrap();

    let mut buf = Vec::new();
    initiator.write_message(&mut buf).unwrap();
    // The s-component decryption uses ee output; mismatched keys produce
    // an auth failure on the second message exchange.
    let result = responder.read_message(&buf);
    // Whether the failure surfaces in message 1 or 2 depends on the
    // wrong-key combination — we just require it to fail before finish.
    if result.is_ok() {
        buf.clear();
        responder.write_message(&mut buf).unwrap_or_default();
        let result2 = initiator.read_message(&buf);
        assert!(result2.is_err());
    }
}

#[test]
fn qr_codec_roundtrip_v2() {
    let payload = QrPayload {
        responder_static_pubkey: [7u8; 32],
        host: "192.168.1.110".to_string(),
        mdns_instance_name: "marklig-laptop-1234".to_string(),
        expiry_unix: 1_715_900_000,
    };
    let encoded = payload.encode();
    assert!(encoded.starts_with("marklig-pair://v2/"));
    let decoded = QrPayload::decode(&encoded).unwrap();
    assert_eq!(payload, decoded);
}

#[test]
fn qr_rejects_wrong_scheme() {
    assert!(QrPayload::decode("https://example.com/").is_err());
    assert!(QrPayload::decode("marklig-pair://v3/abc").is_err());
}

#[test]
fn qr_rejects_truncated() {
    assert!(QrPayload::decode("marklig-pair://v2/AAAA").is_err());
    assert!(QrPayload::decode("marklig-pair://v1/AAAA").is_err());
}

#[test]
fn qr_roundtrips_unicode_host_and_name() {
    let payload = QrPayload {
        responder_static_pubkey: [0u8; 32],
        host: "fe80::1234".to_string(),
        mdns_instance_name: "Märklig-Skrivbord".to_string(),
        expiry_unix: 42,
    };
    let decoded = QrPayload::decode(&payload.encode()).unwrap();
    assert_eq!(payload, decoded);
}

#[test]
fn qr_v1_backwards_compat() {
    // Hand-construct a v1 payload (pre-host field). Should decode with
    // host = "" so the phone can fall back to manual IP entry.
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let mut buf = Vec::new();
    buf.extend_from_slice(&[1u8; 32]);
    let name = b"old-instance";
    buf.extend_from_slice(&(name.len() as u16).to_le_bytes());
    buf.extend_from_slice(name);
    buf.extend_from_slice(&100u64.to_le_bytes());
    let url = format!("marklig-pair://v1/{}", URL_SAFE_NO_PAD.encode(&buf));
    let decoded = QrPayload::decode(&url).unwrap();
    assert_eq!(decoded.host, "");
    assert_eq!(decoded.mdns_instance_name, "old-instance");
    assert_eq!(decoded.expiry_unix, 100);
}

#[test]
fn pair_id_hex_is_32_lowercase_chars() {
    let pid = PairId([0xab; 16]);
    let hex = pid.to_hex();
    assert_eq!(hex.len(), 32);
    assert!(hex.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    assert_eq!(hex, "abababababababababababababababab");
}
