% Range / colon reads on a column vector — also preserves orientation.
c = [10; 20; 30; 40; 50];
a = c(2:4); disp(a);
b = c(end:-1:1); disp(b);
d = c(:); disp(d);
% Same shape from a column-vector range — note disp formatting.
e = c(1:end);
disp(e);
