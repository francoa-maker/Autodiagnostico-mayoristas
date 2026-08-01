-- Reemplaza una imagen de producto eliminada del sitio original.
-- Idempotente: sólo toca la URL rota conocida y conserva cualquier corrección manual posterior.
update portal.products
set image_url = 'https://store.autel.com/cdn/shop/files/Autel_MaxiIM_IMKPA_600x.jpg?v=1734343398'
where sku = '30035'
  and (image_url is null or image_url = 'https://autodiagnostico.com.ar/wp-content/uploads/01-28-600x600.png');
