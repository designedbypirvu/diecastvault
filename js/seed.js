/* Diecast Vault — demo collection used when localStorage is empty */
window.DV = window.DV || {};

DV.seed = (() => {
  const photo = (id) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=900&q=80`;
  const CARDED = 'Mint in Box / Carded';

  // [carBrand, model, series, condition, unsplash photo id]
  const rows = [
    ['Porsche', '911 GT3 RS', '2023 Mainline', CARDED, '1580274455191-1c62238fa333'],
    ['Porsche', '935', 'Boulevard Series', CARDED, '1611821064430-0d40291d0f0b'],
    ['Porsche', '911 Carrera RS 2.7', 'Retro Racers', 'Loose', '1614162692292-7ac56d7f7f1e'],
    ['Porsche', 'Taycan Turbo S Cross Turismo', 'Green Speed', CARDED, '1503376780353-7e6692767b70'],
    ['Porsche', '944 Turbo', 'Turbo Series', CARDED, '1592853625511-ad0edcc69c07'],
    ['Ferrari', 'F40', 'Classic Red Mainline', 'Loose', '1583121274602-3e2820c69888'],
    ['Ferrari', '250 GTO', 'Garage Series', CARDED, '1614200187524-dc4b892acf16'],
    ['Ferrari', 'Enzo', 'HW All Stars', 'Loose', '1617654112368-307921291f42'],
    ['Ferrari', '458 Italia', 'Speed Machines', 'Loose', '1592198084033-aade902d1aae'],
    ['Nissan', 'Skyline GT-R (R34)', 'Fast & Furious Series', CARDED, '1568605117036-5fe5e7bab0b7'],
    ['Lamborghini', 'Countach LPI 800-4', 'HW Exotics', CARDED, '1571607388263-1044f9ea01dd'],
    ['BMW', 'M3 E30', 'HW Race Day', 'Loose', '1580273916550-e323be2ae537'],
    ['Chevrolet', 'Camaro Z28 1969', 'Muscle Mania', 'Loose', '1492144534655-ae79c964c9d7'],
    ['Ford', 'Mustang GT 2024', 'HW Drift', CARDED, '1494976388531-d1058494cdd8'],
    ['Audi', 'RS 6 Avant', 'HW Wagons', CARDED, '1606664515524-ed2f786a0bd6'],
    ['Mazda', 'RX-7 FD', 'Nightburnerz', 'Customized', '1619405399517-d7fce0f13302'],
    ['Dodge', 'Charger Daytona 1969', 'Rod Squad', 'Loose', '1626668893632-6f3a4466d22f'],
    ['McLaren', 'Senna', 'HW Exotics', CARDED, '1542362567-b07e54358753'],
    ['Mercedes-Benz', '190E 2.5-16 EVO II', 'Car Culture', CARDED, '1570733577524-3a047079e80d'],
  ];

  /** Builds fresh seed items. Entry #1 is the most recently added. */
  return function buildSeed() {
    const now = Date.now();
    const HOUR = 36e5;
    return rows.map(([carBrand, model, series, condition, photoId], i) => {
      const createdAt = now - i * 7 * HOUR;
      return {
        id: `seed-${String(i + 1).padStart(2, '0')}`,
        diecastBrand: 'Hot Wheels',
        carBrand,
        model,
        scale: '1:64',
        series,
        condition,
        shelved: false,
        wishlist: false,
        chase: false,
        year: '',
        image: photo(photoId),
        createdAt,
        updatedAt: createdAt,
      };
    });
  };
})();
