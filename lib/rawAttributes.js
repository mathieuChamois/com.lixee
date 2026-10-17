'use strict';

// Lecture d'attributs ZCL par identifiant numérique, décodés avec le type envoyé par le ZLinky.
//
// Pourquoi: zigbee-clusters (2.6.0, embarqué par homey-zigbeedriver) refuse les identifiants
// numériques dans Cluster#readAttributes et décode chaque valeur avec le type déclaré dans la
// définition du cluster. Or certains attributs du ZLinky changent de type selon le firmware
// (SMAXSN: int16 avant v16, int32 depuis). On envoie donc la commande globale « Read
// Attributes » brute (portée par le prototype de base Cluster) et on décode la réponse ici.

const { Cluster } = require('zigbee-clusters');

const rawReadAttributes = Object.getPrototypeOf(Cluster.prototype).readAttributes;

// Taille en octets des types numériques ZCL utiles ici (signé si négatif)
const NUMERIC_TYPES = {
  0x10: 1, // bool
  0x18: 1, 0x19: 2, 0x1A: 3, 0x1B: 4, // bitmaps
  0x20: 1, 0x21: 2, 0x22: 3, 0x23: 4, 0x24: 5, 0x25: 6, // uint8..uint48
  0x28: -1, 0x29: -2, 0x2A: -3, 0x2B: -4, // int8..int32
  0x30: 1, 0x31: 2, // enum8, enum16
};

// Décode la charge utile d'une réponse « Read Attributes »:
// [id uint16][status uint8][type uint8][valeur] ... (type et valeur absents si status != 0)
// Renvoie { [id]: { status, type, value } }.
function decodeReadAttributesResponse(buf) {
  const out = {};
  let i = 0;
  while (buf && i + 3 <= buf.length) {
    const id = buf.readUInt16LE(i);
    const status = buf.readUInt8(i + 2);
    i += 3;
    if (status !== 0) {
      out[id] = { status, type: null, value: undefined };
      continue;
    }
    if (i + 1 > buf.length) break;
    const type = buf.readUInt8(i);
    i += 1;
    let value;
    if (type === 0x41 || type === 0x42) {
      const len = buf.readUInt8(i);
      i += 1;
      if (len === 0xFF) {
        value = null;
      } else {
        const bytes = buf.subarray(i, i + len);
        value = type === 0x42 ? bytes.toString('latin1') : bytes;
        i += len;
      }
    } else if (NUMERIC_TYPES[type] !== undefined) {
      const size = Math.abs(NUMERIC_TYPES[type]);
      if (i + size > buf.length) break;
      value = NUMERIC_TYPES[type] < 0 ? buf.readIntLE(i, size) : buf.readUIntLE(i, size);
      i += size;
    } else {
      // Type non géré: impossible de connaître sa longueur, on arrête le décodage
      out[id] = { status, type, value: undefined };
      break;
    }
    out[id] = { status, type, value };
  }
  return out;
}

// Lit des attributs par identifiant sur un cluster lié (clusters[NAME] d'un endpoint)
async function readRaw(cluster, ids) {
  if (typeof rawReadAttributes !== 'function') {
    throw new Error('lecture brute indisponible dans cette version de zigbee-clusters');
  }
  const response = await rawReadAttributes.call(cluster, { attributes: ids });
  return decodeReadAttributesResponse(response && response.attributes);
}

// Résumé lisible d'un résultat pour la tuile Debug
function describe(result) {
  if (!result) return 'absent';
  if (result.status !== 0) return `non supporté (0x${result.status.toString(16)})`;
  return result.value;
}

module.exports = { readRaw, decodeReadAttributesResponse, describe };
