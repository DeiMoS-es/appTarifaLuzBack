// Este será mi modelo para obtener los precios
class precioModel {
    constructor(response) {
        this.precioZona = response.data.type;
        // Comprueba si 'included' existe y tiene al menos un elemento
        if (response.included && response.included.length > 0) {
            this.moneda = response.included.map(item => item.type);
            this.preciosHoras = response.included.flatMap(item => item.attributes.values.map(valueItem => new Value(valueItem)));
        } else {
            this.moneda = [];
            this.preciosHoras = [];
        }
    }
}

class Value {
    constructor(item) {
        this.precio = item.value;
        this.datetime = item.datetime;
    }
}

module.exports = precioModel;
