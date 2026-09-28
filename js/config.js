/* Diecast Vault — static configuration & preset lists */
window.DV = window.DV || {};

DV.config = Object.freeze({
  STORAGE_KEY: 'diecastvault.collection.v1',
  PREFS_KEY: 'diecastvault.prefs.v1',
  CUSTOM: '__custom__',
  MAX_IMAGE_EDGE: 1000,          // longest side of stored photos, px
  MIN_IMAGE_EDGE: 480,           // never shrink below this to hit the size budget
  MAX_IMAGE_BYTES: 120 * 1024,   // target size per stored photo

  DIECAST_BRANDS: [
    'Hot Wheels', 'Matchbox', 'Maisto', 'Bburago', 'Welly', 'Mini GT', 'Kaido House',
    'Inno64', 'Tomica', 'Autoart', 'Kyosho', 'Greenlight', 'Johnny Lightning',
    'Majorette', 'Solido', 'Norev', 'IXO Models', 'Spark', 'Tarmac Works', 'Jada Toys',
  ],

  CAR_BRANDS: [
    'Porsche', 'Ferrari', 'Lamborghini', 'BMW', 'Mercedes-Benz', 'Audi', 'Volkswagen',
    'Ford', 'Chevrolet', 'Dodge', 'Nissan', 'Toyota', 'Honda', 'Mazda', 'Subaru',
    'Alfa Romeo', 'Aston Martin', 'Bentley', 'Bugatti', 'Cadillac', 'McLaren', 'Maserati',
    'Koenigsegg', 'Pagani', 'Shelby', 'Volvo', 'Land Rover', 'Jaguar', 'Mitsubishi', 'Lexus',
  ].sort((a, b) => a.localeCompare(b)),

  SCALES: ['1:64', '1:43', '1:36', '1:24', '1:18'],

  SERIES: ['Mainline', 'Silver Series', 'Premium', 'Limited Edition', 'RLC'],

  CONDITIONS: [
    { value: 'Mint in Box / Carded', short: 'Carded', tone: 'mint', icon: 'package-check' },
    { value: 'Loose', short: 'Loose', tone: 'loose', icon: 'package-open' },
    { value: 'Customized', short: 'Custom', tone: 'custom', icon: 'wrench' },
  ],

  SORTS: [
    { value: 'newest', label: 'Newest added' },
    { value: 'oldest', label: 'Oldest added' },
    { value: 'car', label: 'Car brand A–Z' },
    { value: 'model', label: 'Model name A–Z' },
    { value: 'year', label: 'Model year' },
  ],
});
