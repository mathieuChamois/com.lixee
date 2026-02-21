### LiXee – Intégration ZLinky_TIC & ZiPulses pour Homey

Cette application Homey permet de connecter vos modules **LiXee** à votre box Homey via Zigbee 3.0 pour le suivi de consommation d'énergie.

#### Appareils supportés

| Appareil | Usage |
|----------|-------|
| **ZLinky_TIC** | Télé-information Linky (électricité) |
| **ZiPulses** | Compteur d'impulsions (électricité, eau, gaz) |

## ZLinky_TIC

Le ZLinky_TIC se connecte à la prise TIC de votre compteur Linky et remonte en temps réel les données de télé-information.

**Fonctionnalités :**
- Puissance apparente instantanée (mono et triphasé)
- Index de consommation et de production
- Contrats supportés : BASE, HC/HP, Tempo, EJP (historique et standard)
- Couleur Tempo du jour et du lendemain
- Intensité, tension, courant par phase
- Flow cards pour automatiser selon la période tarifaire ou le dépassement de puissance
- Compatible onglet Énergie Homey

**Remarque :** le ZLinky_TIC n'est pas compatible avec les compteurs Linky ISKRA disposant d'un port USB (seulement 2 broches TIC).

## ZiPulses

Le ZiPulses est un compteur d'impulsions Zigbee 3.0 qui se connecte à la sortie impulsion (S0 / contact sec) de votre compteur d'électricité, d'eau ou de gaz.

### Fonctionnalités

- **Index calculé** avec unité configurable (kWh, Wh, L, m³, ft³, gal)
- **Impulsions brutes** (compteur cumulatif)
- **Température** intégrée (prévention gel)
- **Batterie** (pile CR2450 ou alimentation externe 5-12V)
- **Capabilities natives Homey** (`meter_power`, `meter_water`, `meter_gas`) pour compatibilité avec l'onglet Énergie et Power by the Hour
- **Multiplicateur / Diviseur** configurables pour s'adapter à tout type de compteur

### Configuration

Après l'appairage, allez dans les **Paramètres** de l'appareil.

#### 1. Type de compteur

Choisissez le type pour activer la capability native Homey correspondante :

| Type | Capability Homey | Unité native |
|------|-----------------|--------------|
| Électricité | `meter_power` | kWh |
| Eau | `meter_water` | m³ |
| Gaz | `meter_gas` | m³ |
| Personnalisé | aucune | — |

#### 2. Formule de calcul
```
Index = impulsions × multiplicateur ÷ diviseur
```

#### 3. Exemples de configuration

| Compteur | Mult | Div | Unité | Exemple |
|----------|------|-----|-------|---------|
| Linky direct (1 Wh/imp) | 1 | 1000 | kWh | 5000 imp → 5.000 kWh |
| Sous-compteur S0 (10 Wh/imp) | 10 | 1000 | kWh | 500 imp → 5.000 kWh |
| Compteur eau (1 imp/L) | 1 | 1 | L | 150 imp → 150 L |
| Gazpar (1 imp = 0.01 m³) | 1 | 100 | m³ | 500 imp → 5.000 m³ |

### Power by the Hour

Installez l'app **Power by the Hour** depuis le Homey App Store pour obtenir automatiquement la consommation par heure, jour, mois et année. Assurez-vous de sélectionner le bon **type de compteur** dans les paramètres du ZiPulses.

## Appairage

1. Dans Homey : **Appareils** → **+** → **liXee**
2. Sélectionnez **ZLinky_TIC** ou **ZiPulses**
3. Mettez l'appareil en mode appairage (appui 2-3 secondes sur le bouton **Link**)
4. La LED clignote rapidement → relâchez

Si l'appareil était déjà appairé en Zigbee générique, supprimez-le d'abord de Homey.

## Clusters Zigbee

| Cluster | ID | ZLinky_TIC | ZiPulses |
|---------|----|:----------:|:--------:|
| Power Configuration | 0x0001 | — | ✓ Batterie |
| Temperature Measurement | 0x0402 | — | ✓ Température |
| Metering | 0x0702 | ✓ Index | ✓ Impulsions |
| Electrical Measurement | 0x0B04 | ✓ Puissance | — |
| Meter Identification | 0x0B01 | ✓ Série | — |
| LiXee Private | 0xFF66 | ✓ Tarifs | — |